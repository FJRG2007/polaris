/**
 * Signing in through a SAML identity provider (Okta, Entra ID, Google
 * Workspace, Keycloak and the like).
 *
 * The SAML work itself - the signature, the audience, the recipient, the
 * validity window, the request it answers and the assertion that must never be
 * accepted twice - is the official better-auth SSO plugin's, which does it with
 * samlify. Nothing here parses or verifies XML. What Polaris adds is policy:
 *
 * - Providers are configured only by a platform administrator, through
 *   Polaris's own action. The plugin's endpoints for registering, editing and
 *   verifying providers are closed, so no signed-in user can add an identity
 *   provider that would then vouch for somebody else's address.
 * - A first sign-in creates an account only when that provider allows it, and
 *   only for an address in one of that provider's own domains.
 * - Where a provider is enforced, every other way in for its domains is refused,
 *   except for a platform administrator, whose password is the way back in when
 *   the provider is broken.
 * - The address a sign-in returns to is a path on this deployment, never a URL.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { sso } from "@better-auth/sso";
import { Extractor } from "samlify";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/** The sign-in that starts at the identity provider's door. */
export const SSO_SIGN_IN_PATH = "/sign-in/sso";

/** The code a refused password sign-in answers with, so the screen can offer SSO. */
export const SSO_REQUIRED_CODE = "SSO_REQUIRED";

/** Where a refused SAML response lands: the sign-in screen, with a generic notice. */
export const SSO_ERROR_PATH = "/oauth/login?error=sso";

/** The plugin's key for a sign-in request it issued, the one a response must answer. */
const AUTHN_REQUEST_PREFIX = "saml-authn-request:";

/** The two routes a SAML response is posted to. */
export const ASSERTION_PATHS: ReadonlySet<string> = new Set([
    "/sso/saml2/sp/acs/:providerId",
    "/sso/saml2/callback/:providerId"
]);

/** How far apart the two clocks may be before an assertion is out of its window. */
const CLOCK_SKEW_MS = 3 * 60 * 1000;

/**
 * The plugin endpoints Polaris does not expose: provider management is the
 * admin action's, and an endpoint that let any signed-in account register an
 * identity provider is an endpoint that lets it mint other people's sign-ins.
 */
export const CLOSED_SSO_PATHS: ReadonlySet<string> = new Set([
    "/sso/register",
    "/sso/update-provider",
    "/sso/delete-provider",
    "/sso/providers",
    "/sso/get-provider",
    "/sso/request-domain-verification",
    "/sso/verify-domain"
]);

/** The password and emailed-link sign-ins an enforced domain may not use. */
const PASSWORD_PATHS: ReadonlySet<string> = new Set(["/sign-in/email", "/sign-in/magic-link"]);

/** The return addresses `/sign-in/sso` accepts, each of which must be a path here. */
const RETURN_FIELDS = ["callbackURL", "errorCallbackURL", "newUserCallbackURL"] as const;

/** Every provider's sign-in policy, as the domain rules read it. */
export async function samlDomainPolicies(): Promise<
    (core.SamlDomainPolicy & { allowSignUp: boolean })[]
> {
    const rows = await prisma.ssoProvider.findMany({
        select: {
            providerId: true,
            domain: true,
            enforced: true,
            domainVerified: true,
            allowSignUp: true
        }
    });
    return rows.map((row) => ({
        providerId: row.providerId,
        domains: core.parseSamlDomains(row.domain),
        enforced: row.enforced,
        domainVerified: row.domainVerified,
        allowSignUp: row.allowSignUp
    }));
}

/**
 * Refuses a password sign-in for an address whose domain must use its identity
 * provider. Answers before the password is checked, from the domain alone where
 * it can, so an address with no account is refused the same way as one with.
 */
async function refusePasswordForEnforcedDomain(email: string): Promise<void> {
    const providers = await samlDomainPolicies();
    if (!core.passwordSignInRefused({ email, isAdmin: false }, providers)) return;
    const user = await prisma.user.findUnique({
        where: { email: email.trim().toLowerCase() },
        select: { isAdmin: true }
    });
    if (core.passwordSignInRefused({ email, isAdmin: user?.isAdmin ?? false }, providers)) {
        throw new APIError("FORBIDDEN", {
            code: SSO_REQUIRED_CODE,
            message: "This account signs in with single sign-on."
        });
    }
}

/**
 * Refuses a session for an account whose domain must use its identity provider,
 * when it comes through a way in that never asks that provider - a passkey, a
 * scanned code, an emailed link, a connected account. Without this, someone
 * offboarded at the provider keeps every other door. A platform administrator
 * passes, as with a password.
 */
export async function refuseSessionForEnforcedDomain(userId: string): Promise<void> {
    const providers = await samlDomainPolicies();
    if (!providers.some((provider) => provider.enforced && provider.domainVerified)) return;
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, isAdmin: true }
    });
    if (user && core.passwordSignInRefused(user, providers)) {
        throw new APIError("FORBIDDEN", {
            code: SSO_REQUIRED_CODE,
            message: "This account signs in with single sign-on."
        });
    }
}

/**
 * Whether the sign-in in progress may create this account: only a sign-in that
 * came through a provider that allows it, for an address in that provider's own
 * domains. Any other path is not this rule's to judge and passes untouched.
 */
export async function samlSignUpAllowed(
    email: string,
    context: { path?: string; params?: Record<string, string> } | null
): Promise<boolean> {
    if (!context?.path?.startsWith("/sso/")) return true;
    const providerId = context.params?.providerId;
    if (!providerId) return false;
    const provider = (await samlDomainPolicies()).find((entry) => entry.providerId === providerId);
    if (!provider?.allowSignUp) return false;
    return core.providerForEmail(email, [provider]) !== null;
}

/**
 * The request id a SAML response says it answers, read with the same library
 * the plugin parses the response with, so the two can never disagree about it.
 */
export function samlResponseRequestId(encoded: string): string | null {
    try {
        const xml = Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("utf8");
        const { response } = Extractor.extract(xml, [
            { key: "response", localPath: ["Response"], attributes: ["ID", "InResponseTo"] }
        ]) as { response?: { inResponseTo?: unknown } | null };
        const id = response?.inResponseTo;
        return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : null;
    } catch {
        return null;
    }
}

/**
 * Refuses a SAML response that does not answer a sign-in started here, for this
 * provider, and spends that request so the same response can never be posted
 * twice.
 *
 * The plugin means to do this itself, but the version pinned here reads the
 * request id from a field the response parser never fills, so with IdP-initiated
 * sign-in off it refuses every sign-in, and with it on it checks nothing. Polaris
 * therefore turns the plugin's check off and does it here, before the response is
 * looked at. The test suite signs in end to end, so a plugin upgrade that changes
 * this fails there rather than in production.
 */
async function requireAnsweredRequest(ctx: {
    body?: unknown;
    params?: Record<string, string>;
    context: {
        baseURL: string;
        logger: { warn: (message: string, ...args: unknown[]) => void };
        internalAdapter: {
            consumeVerificationValue: (identifier: string) => Promise<{ value: string } | null>;
        };
    };
    redirect: (url: string) => unknown;
}): Promise<void> {
    const refuse = (reason: string): never => {
        ctx.context.logger.warn(`SAML response refused: ${reason}`, {
            providerId: ctx.params?.providerId
        });
        throw ctx.redirect(`${new URL(ctx.context.baseURL).origin}${SSO_ERROR_PATH}`);
    };
    const encoded = (ctx.body as { SAMLResponse?: unknown } | undefined)?.SAMLResponse;
    if (typeof encoded !== "string") return refuse("no response");
    const requestId = samlResponseRequestId(encoded);
    if (!requestId) return refuse("it answers no sign-in request");
    const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
        `${AUTHN_REQUEST_PREFIX}${requestId}`
    );
    let providerId: unknown = null;
    try {
        providerId = consumed
            ? (JSON.parse(consumed.value) as { providerId?: unknown }).providerId
            : null;
    } catch {
        providerId = null;
    }
    if (!consumed) return refuse("unknown, expired or already answered request");
    if (providerId !== ctx.params?.providerId) return refuse("request was for another provider");
}

/** The SSO plugin with Polaris's rules around it. */
export function samlSsoPlugin(): BetterAuthPlugin {
    const plugin = sso({
        // Polaris's action proves the domains (a DNS record) before it marks a
        // provider verified; the plugin refuses an unverified provider and links
        // an existing account only when the address is in a verified domain.
        domainVerification: { enabled: true },
        // Account creation is decided per provider by `samlSignUpAllowed`.
        disableImplicitSignUp: false,
        providersLimit: 0,
        saml: {
            // The plugin still records each sign-in request it issues; whether a
            // response answers one is checked by `requireAnsweredRequest`, which
            // also refuses every unsolicited (IdP-initiated) response.
            enableInResponseToValidation: true,
            allowIdpInitiated: true,
            requireTimestamps: true,
            clockSkew: CLOCK_SKEW_MS,
            algorithms: { onDeprecated: "reject" }
        }
    }) as unknown as BetterAuthPlugin;

    return {
        ...plugin,
        hooks: {
            ...plugin.hooks,
            before: [
                {
                    matcher: (context) => CLOSED_SSO_PATHS.has(context.path ?? ""),
                    handler: createAuthMiddleware(async () => {
                        throw new APIError("NOT_FOUND");
                    })
                },
                {
                    matcher: (context) => context.path === SSO_SIGN_IN_PATH,
                    handler: createAuthMiddleware(async (ctx) => {
                        const body = (ctx.body ?? {}) as Record<string, unknown>;
                        for (const field of RETURN_FIELDS) {
                            const value = body[field];
                            if (value === undefined) continue;
                            if (typeof value !== "string" || core.sameOriginPath(value) === null) {
                                throw new APIError("BAD_REQUEST", {
                                    message: "Invalid return address."
                                });
                            }
                        }
                    })
                },
                {
                    matcher: (context) => ASSERTION_PATHS.has(context.path ?? ""),
                    handler: createAuthMiddleware(async (ctx) => {
                        await requireAnsweredRequest(ctx as never);
                    })
                },
                {
                    matcher: (context) => PASSWORD_PATHS.has(context.path ?? ""),
                    handler: createAuthMiddleware(async (ctx) => {
                        const email = (ctx.body as { email?: unknown } | undefined)?.email;
                        if (typeof email === "string") await refusePasswordForEnforcedDomain(email);
                    })
                },
                ...(plugin.hooks?.before ?? [])
            ]
        }
    };
}
