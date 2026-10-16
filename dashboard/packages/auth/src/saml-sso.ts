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
 * - Where a provider is enforced, a password sign-in for its domains is refused,
 *   except for a platform administrator, whose password is the way back in when
 *   the provider is broken.
 * - The address a sign-in returns to is a path on this deployment, never a URL.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/** The sign-in that starts at the identity provider's door. */
export const SSO_SIGN_IN_PATH = "/sign-in/sso";

/** The code a refused password sign-in answers with, so the screen can offer SSO. */
export const SSO_REQUIRED_CODE = "SSO_REQUIRED";

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
        select: { providerId: true, domain: true, enforced: true, domainVerified: true, allowSignUp: true }
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
            enableInResponseToValidation: true,
            // Only answers to a sign-in that started here: an unsolicited
            // response cannot be tied to a request, so it cannot be told apart
            // from one replayed or injected.
            allowIdpInitiated: false,
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
                                throw new APIError("BAD_REQUEST", { message: "Invalid return address." });
                            }
                        }
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
