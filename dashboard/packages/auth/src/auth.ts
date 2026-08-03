/**
 * better-auth configuration for Polaris. Exposed as a factory rather than a
 * module-level singleton so importing this package never reads the environment
 * or constructs a client at load time - the app calls createAuth() once, where
 * POLARIS_* env is guaranteed present.
 *
 * Email/password is the only enabled method for now. The custom isAdmin field is
 * mirrored onto the session user for the admin double-gate, but is input:false so
 * it can never be set through the public sign-up payload - only server code
 * flips it. trustedOrigins stays an allowlist - the app URL, the local names, and
 * the domains this deployment is configured to answer on - to blunt the
 * open-redirect and origin-check classes of issue this library has historically
 * had. A request's own Host header decides only which of those already-trusted
 * names a passkey is bound to; on its own it is the attacker's to set.
 */

import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { passkey } from "@better-auth/passkey";
import { setSessionCookie } from "better-auth/cookies";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deviceAuthorization, magicLink, twoFactor } from "better-auth/plugins";
import {
    passkeyRelyingPartyId,
    QR_SIGN_IN_CLIENT_ID,
    QR_SIGN_IN_POLL_SECONDS,
    QR_SIGN_IN_TTL_SECONDS,
    TWO_FACTOR_CODE_ATTEMPTS,
    TWO_FACTOR_CODE_TTL_MINUTES,
    TWO_FACTOR_METHOD_HEADER
} from "@polaris/core";

/** Session lifetime: 7 days, refreshed at most once per day. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE = 60 * 60 * 24;

/** How long an emailed sign-in link stays good. Short: it is a bearer credential
 *  sitting in an inbox, and the user is asking to sign in right now. */
const MAGIC_LINK_TTL_SECONDS = 10 * 60;

/**
 * WebAuthn binds a credential to one registrable domain, so the relying party
 * follows the address the request arrived on instead of being pinned to the
 * published one: the same Polaris is opened as polaris.local on the LAN and as
 * its domain from outside, and both have to be able to hold a passkey. One
 * credential still only works on the address it was created on - the account
 * page says so, and offers to add one wherever the user actually is.
 *
 * The address is checked against the trusted list before it reaches here; an
 * address that cannot be a relying party at all - a bare IP - leaves the plugin
 * unregistered, so its endpoints are absent rather than failing halfway.
 */
function passkeyPlugin(address: string): BetterAuthPlugin | null {
    const rpID = passkeyRelyingPartyId(address);
    if (!rpID) return null;
    return passkey({
        rpID,
        rpName: "Polaris",
        // Pinned rather than left for the client to supply: an origin the caller
        // chooses is an origin an attacker chooses. The port rides along, since
        // it is part of the origin the browser reports.
        origin: origins(address)
    }) as BetterAuthPlugin;
}

/**
 * The two-factor plugin, with the code-by-message provider registered only when
 * the app supplied a way to deliver one. Left out, its endpoints do not exist,
 * so a build that cannot send never advertises a method it would fail at.
 *
 * The method the user picked arrives as a request header rather than in the body:
 * the send-otp endpoint validates its body against a fixed shape of its own and
 * would drop an extra field. It is only a routing hint - the delivery callback
 * checks it against what the account actually accepts before sending anywhere.
 */
function twoFactorPlugin(options: AuthOptions): BetterAuthPlugin {
    const send = options.sendTwoFactorCode;
    if (!send) return gateEmailedLink(twoFactor({ issuer: "Polaris" }));
    return gateEmailedLink(
        twoFactor({
            issuer: "Polaris",
            otpOptions: {
                period: TWO_FACTOR_CODE_TTL_MINUTES,
                allowedAttempts: TWO_FACTOR_CODE_ATTEMPTS,
                // The code is a short-lived, low-entropy secret; store it the way
                // any other one is rather than in the clear next to the account it
                // opens.
                storeOTP: "hashed",
                sendOTP: async ({ user, otp }, ctx) => {
                    const requested = ctx?.headers?.get(TWO_FACTOR_METHOD_HEADER) ?? null;
                    const result = await send({ userId: user.id, requested, code: otp });
                    // better-auth answers send-otp the same way whether or not this
                    // callback managed anything, so a failure is only ever recorded
                    // here. Telling the caller would say which methods an account
                    // has, to somebody who has not finished proving who they are.
                    if (result.error) console.error("two-factor code not sent:", result.error);
                }
            }
        })
    );
}

/**
 * Signing in by scanning the QR code on the sign-in screen, on better-auth's
 * device-authorization plugin (RFC 8628). The waiting screen holds a device code
 * and polls with it; the phone that scans holds the short user code and answers.
 *
 * Every one of its endpoints is sealed off from the network (see sealDeviceFlow):
 * this is not a public device flow, it is one screen of Polaris talking to
 * another, and the rules that make it safe - who may open a code, how often, and
 * the quick-unlock PIN that has to be typed to allow one - live in Polaris's own
 * actions. An endpoint reachable over HTTP would be a way around all three.
 */
function deviceAuthorizationPlugin(): BetterAuthPlugin {
    return sealDeviceFlow(
        deviceAuthorization({
            expiresIn: `${QR_SIGN_IN_TTL_SECONDS}s`,
            interval: `${QR_SIGN_IN_POLL_SECONDS}s`,
            validateClient: (clientId) => clientId === QR_SIGN_IN_CLIENT_ID
        }) as BetterAuthPlugin
    );
}

/** The paths the device flow answers on, all of them Polaris-internal. */
const DEVICE_PATHS: ReadonlySet<string> = new Set([
    "/device/code",
    "/device",
    "/device/approve",
    "/device/deny",
    "/device/token"
]);

/** Where the approved exchange hands back a session for the waiting browser. */
const DEVICE_TOKEN_PATH = "/device/token";

/**
 * Close the device flow to the network, and make the exchange that ends it issue
 * a session cookie.
 *
 * Both hooks exist because the plugin is built for a different shape of client
 * than this one. It expects a TV or a CLI: anybody may ask for a code, approving
 * needs nothing but a session, and the exchange hands back a bearer token. Here
 * the same three steps are Polaris's own screens, so a code is opened by the
 * sign-in page under a rate limit, an approval costs the quick-unlock PIN, and
 * what the browser needs at the end is the cookie every other sign-in leaves.
 *
 * `ctx.request` is set only when a request arrived over HTTP; a server-side
 * `auth.api` call leaves it undefined, which is what separates Polaris's actions
 * from anything else. The plugin uses the same distinction itself for its
 * client-request switch, so it is the library's own line rather than one drawn
 * here.
 */
function sealDeviceFlow(plugin: BetterAuthPlugin): BetterAuthPlugin {
    return {
        ...plugin,
        hooks: {
            ...plugin.hooks,
            before: [
                ...(plugin.hooks?.before ?? []),
                {
                    matcher: (context) => DEVICE_PATHS.has(context.path ?? ""),
                    handler: createAuthMiddleware(async (ctx) => {
                        if (!ctx.request) return;
                        throw new APIError("NOT_FOUND", { message: "Not found" });
                    })
                }
            ],
            after: [
                ...(plugin.hooks?.after ?? []),
                {
                    matcher: (context) => context.path === DEVICE_TOKEN_PATH,
                    handler: createAuthMiddleware(async (ctx) => {
                        // Only set on the one exchange that found an approved
                        // code; every other outcome throws before reaching here.
                        const issued = ctx.context.newSession;
                        if (issued) await setSessionCookie(ctx, issued);
                    })
                }
            ]
        }
    };
}

/** Where an emailed sign-in link is redeemed. */
export const MAGIC_LINK_VERIFY_PATH = "/magic-link/verify";

/**
 * Make an emailed sign-in link raise the second-factor challenge too.
 *
 * better-auth's two-factor plugin only watches the credential sign-in paths, so
 * on its own an emailed link hands an account with an armed authenticator a full
 * session - no password and no code - which makes the mailbox a single point of
 * failure for exactly the accounts that asked for it not to be. The hook's own
 * handler is path-agnostic (it takes back the session the endpoint just created,
 * then starts the challenge), so covering the link is a matter of widening what
 * it matches; reimplementing the challenge here instead would leave two copies
 * of it to drift apart.
 *
 * A version of better-auth that moved the hook throws at start-up rather than
 * quietly reopening the path - this is the only thing closing it, and the shape
 * it depends on is pinned by a test.
 */
function gateEmailedLink(plugin: BetterAuthPlugin): BetterAuthPlugin {
    const hooks = plugin.hooks?.after ?? [];
    const signIn = hooks.find((hook) => hook.matcher({ path: "/sign-in/email" } as never));
    if (!signIn) {
        throw new Error("better-auth's two-factor plugin no longer gates sign-in where Polaris expects it");
    }
    const matches = signIn.matcher;
    return {
        ...plugin,
        hooks: {
            ...plugin.hooks,
            after: hooks.map((hook) =>
                hook === signIn
                    ? {
                          ...hook,
                          matcher: (context) =>
                              matches(context) || context.path === MAGIC_LINK_VERIFY_PATH
                      }
                    : hook
            )
        }
    };
}

/**
 * The sign-in methods beyond a password: a TOTP second factor with single-use
 * backup codes, passkeys, scanning the sign-in screen's QR code from a device
 * that is already signed in, and - on a deployment that has a mail sender -
 * sign-in by emailed link. Verification is required before the authenticator is
 * armed, so a user who mis-scans the QR cannot lock themselves out.
 *
 * Typed as the plugin base rather than left inferred: the plugin's endpoint
 * types embed better-auth's own nested zod, which this package cannot name in
 * its emitted declarations. The browser client declares the two-factor paths it
 * calls, so nothing loses type safety - the flow runs through @polaris/web's
 * auth client, not through auth.api here.
 */
function buildPlugins(options: AuthOptions, address: string): BetterAuthPlugin[] {
    const plugins: BetterAuthPlugin[] = [twoFactorPlugin(options), deviceAuthorizationPlugin()];
    const webauthn = passkeyPlugin(address);
    if (webauthn) plugins.push(webauthn);
    // Registered only when the app can send at all. Whether a channel is
    // nominated right now is the send callback's business.
    if (options.sendMail) {
        const send = options.sendMail;
        plugins.push(
            magicLink({
                expiresIn: MAGIC_LINK_TTL_SECONDS,
                // Registration is closed here as it is everywhere else: a link to
                // an address with no account must not conjure one.
                disableSignUp: true,
                sendMagicLink: async ({ email, url }) => {
                    const result = await send({
                        to: email,
                        subject: "Your Polaris sign-in link",
                        text: `Sign in to Polaris:\n\n${url}\n\nThe link works once and expires in 10 minutes. If you did not ask to sign in, ignore this message.`,
                        html: `<p>Sign in to Polaris:</p><p><a href="${url}">Sign in</a></p><p>The link works once and expires in 10 minutes. If you did not ask to sign in, ignore this message.</p>`
                    });
                    // Surfacing the reason would tell an unauthenticated caller
                    // whether the address has an account; the endpoint answers the
                    // same either way and the failure is logged instead.
                    if (result.error) console.error("magic link not sent:", result.error);
                }
            }) as BetterAuthPlugin
        );
    }
    return plugins;
}

/** Both schemes for a hostname: a deployment is reached over plain HTTP on the LAN
 *  and over HTTPS on its domain, often the same day. */
function origins(host: string): string[] {
    return [`https://${host}`, `http://${host}`];
}

export interface AuthOptions {
    /**
     * Hostnames this deployment answers on beyond the ones fixed in the
     * environment - the domains an operator configured after install.
     *
     * Resolved per request rather than at startup, because they are configured
     * while the server is running: a domain saved in the panel used to leave
     * sign-in on that domain failing with INVALID_ORIGIN until the container was
     * restarted. Supplied by the app, which owns where they are stored; failures
     * are the caller's to swallow, and cost only the extra origins.
     */
    readonly configuredHosts?: () => Promise<readonly string[]>;

    /**
     * How to send an account message. Supplied by the app, which owns the channel
     * that carries it; omitting it is what leaves the mail-backed sign-in methods
     * unregistered, so a build that cannot send never exposes their endpoints.
     *
     * Whether a channel is actually nominated is resolved per send rather than
     * here, so an operator configuring mail does not have to restart anything.
     * Returns the reason it could not be sent rather than throwing, so a failure
     * inside better-auth's request handling never fails the whole request.
     */
    readonly sendMail?: (message: {
        to: string;
        subject: string;
        text: string;
        html?: string;
    }) => Promise<{ error?: string }>;

    /**
     * How to get a second-factor code to the person signing in. Supplied by the
     * app, which owns the channels that carry it and knows which of them the
     * account has turned on; omitting it leaves the code-by-message provider
     * unregistered, so the authenticator stays the only second factor.
     *
     * `requested` is the method the challenge screen asked for, unvalidated. The
     * implementation decides where the code actually goes and reports why it
     * could not go rather than throwing - better-auth swallows a rejection here.
     */
    readonly sendTwoFactorCode?: (input: {
        userId: string;
        requested: string | null;
        code: string;
    }) => Promise<{ error?: string }>;
}

/** The addresses fixed at start-up: the published one and the local-network names
 *  (homeassistant.local style), as bare hostnames - a port is not part of a
 *  relying party, and the configured domains are stored without one either. */
function fixedHosts(): string[] {
    const env = loadEnv();
    const localName = env.POLARIS_LOCAL_HOSTNAME;
    const published = passkeyRelyingPartyId(env.POLARIS_APP_URL);
    return [...(published ? [published] : []), `${localName}.local`, localName];
}

/**
 * Every hostname this deployment answers on: the fixed ones plus the domains an
 * operator configured after install. Resolved per call for the same reason the
 * trusted origins are - a domain saved in the panel has to work without a restart.
 */
async function allowedHosts(options: AuthOptions): Promise<Set<string>> {
    const configured = options.configuredHosts ? await options.configuredHosts().catch(() => []) : [];
    return new Set([...fixedHosts(), ...configured]);
}

/**
 * @param address The host the passkey relying party is bound to, as `host[:port]`.
 *                Defaults to the published app URL, which is what every caller
 *                outside the request handler wants.
 */
export function createAuth(options: AuthOptions = {}, address?: string) {
    const env = loadEnv();
    const localName = env.POLARIS_LOCAL_HOSTNAME;
    // Trust the public origin plus the local-network names (homeassistant.local
    // style) so the dashboard works whether reached by domain, polaris.local, or
    // bare polaris. Deduplicated in case the app URL is already one of them.
    const fixedOrigins = Array.from(
        new Set([
            env.POLARIS_APP_URL,
            ...origins(`${localName}.local`),
            `http://${localName}`
        ])
    );
    return betterAuth({
        appName: "Polaris",
        secret: env.POLARIS_AUTH_SECRET,
        baseURL: env.POLARIS_APP_URL,
        trustedOrigins: async () => {
            if (!options.configuredHosts) return fixedOrigins;
            const hosts = await options.configuredHosts().catch(() => []);
            return [...fixedOrigins, ...hosts.flatMap(origins)];
        },
        database: prismaAdapter(prisma, { provider: env.POLARIS_DB_PROVIDER }),
        emailAndPassword: {
            enabled: true,
            // Public registration is closed: the only paths to an account are the
            // one-time admin setup and an admin invite, both of which create the
            // user server-side (see provisionUser). Sign-in stays open.
            disableSignUp: true,
            requireEmailVerification: false,
            minPasswordLength: 10
        },
        session: {
            expiresIn: SESSION_MAX_AGE,
            updateAge: SESSION_UPDATE_AGE
        },
        plugins: buildPlugins(options, address ?? new URL(env.POLARIS_APP_URL).host),
        user: {
            additionalFields: {
                // Server-only flag; never accepted from client input.
                isAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
                // Unique handle, set server-side during setup/invite provisioning.
                username: { type: "string", required: false, input: false }
            }
        },
        advanced: {
            cookiePrefix: "polaris",
            // Off by default so sign-in works over plain HTTP (polaris.local on the
            // LAN); set POLARIS_SECURE_COOKIES=true for an HTTPS deployment.
            useSecureCookies: env.POLARIS_SECURE_COOKIES,
            // The id columns are native uuid; better-auth generates the ids for its
            // own tables (User/Session/Account/Verification), so emit UUIDs here to
            // match. App-owned tables get UUIDv7 from the Prisma @default.
            database: { generateId: () => randomUUID() }
        }
    });
}

export type Auth = ReturnType<typeof createAuth>;

/** How many address-bound instances to keep. The names a deployment answers on
 *  are few and fixed by its configuration; the cap is only there so a forged Host
 *  header cannot make the process hold on to an unbounded number of them. */
const MAX_RELYING_PARTIES = 32;

export interface RequestAuth {
    /** The shared instance, bound to the published address. Session reads, server
     *  actions, and anything else that is not a WebAuthn ceremony use this. */
    readonly auth: Auth;

    /** Serve one better-auth request with the instance for the address it arrived
     *  on. This is what the catch-all route exports. */
    readonly handle: (request: Request) => Promise<Response>;
}

/**
 * A better-auth handler whose passkey relying party follows the address in the
 * request, so a passkey can be registered and used on whichever of this
 * deployment's names the browser is actually on.
 *
 * The address is only believed when it names a host already trusted for origins -
 * a Host header is the caller's to set - and an unrecognized one falls back to the
 * published address, which is what every non-WebAuthn endpoint would have used
 * anyway. Instances are cached because building one is not free.
 */
export function createRequestAuth(options: AuthOptions = {}): RequestAuth {
    const shared = createAuth(options);
    const published = new URL(loadEnv().POLARIS_APP_URL).host;
    const byAddress = new Map<string, Auth>();

    function instanceFor(address: string | null): Auth {
        // The shared instance is already bound to the published address, which is
        // the address most requests arrive on.
        if (!address || address === published) return shared;
        const cached = byAddress.get(address);
        if (cached) return cached;
        if (byAddress.size >= MAX_RELYING_PARTIES) return shared;
        const instance = createAuth(options, address);
        byAddress.set(address, instance);
        return instance;
    }

    return {
        auth: shared,
        handle: async (request) => {
            const address = await resolvePasskeyAddress(request, options);
            const response = await instanceFor(address).handler(request);
            return address ? recordRelyingParty(request, response, address) : response;
        }
    };
}

/**
 * The `host[:port]` a request arrived on, or null when this deployment does not
 * answer on it, or it could never hold a passkey anyway.
 *
 * The header is only believed to the extent that it names a hostname already
 * trusted for origins: a Host is the caller's to set, and it decides which
 * relying party a credential is created under.
 */
export async function resolvePasskeyAddress(
    request: Request,
    options: AuthOptions
): Promise<string | null> {
    const header = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const address = header?.trim().toLowerCase() ?? "";
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(address)) return null;
    const rpID = passkeyRelyingPartyId(address);
    if (!rpID) return null;
    return (await allowedHosts(options)).has(rpID) ? address : null;
}

/**
 * Record which address a newly registered passkey is bound to. The plugin's own
 * row does not carry it, and without it the account page cannot say where a
 * passkey works and the sign-in page cannot tell whether offering one here would
 * do anything but raise a prompt that fails.
 *
 * Read from the response rather than reported by the browser afterwards, so the
 * binding is whatever the server actually issued the challenge for.
 */
export async function recordRelyingParty(
    request: Request,
    response: Response,
    address: string
): Promise<Response> {
    if (response.status !== 200) return response;
    if (!new URL(request.url).pathname.endsWith("/passkey/verify-registration")) return response;
    const created: unknown = await response.clone().json().catch(() => null);
    const id = (created as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return response;
    await prisma.passkey
        .update({ where: { id }, data: { rpId: passkeyRelyingPartyId(address) } })
        // The passkey exists and works either way; only the label for it is lost,
        // so this must not turn a successful registration into a failed request.
        .catch((error: unknown) => console.error("passkey address not recorded:", error));
    return response;
}
