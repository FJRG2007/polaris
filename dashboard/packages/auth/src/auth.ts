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
import { passwordConfirmed } from "./security.js";
import { setSessionCookie } from "better-auth/cookies";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { newDeviceWaitMessage, sessionDeviceStanding } from "./devices.js";
import { deviceAuthorization, magicLink, twoFactor } from "better-auth/plugins";
import { noteSecondFactor, noteSentCodeAnswered, noteSignIn } from "./sign-in-record.js";
import { connectionSignInPlugin, CONNECTION_SIGN_IN_PATH } from "./connection-sign-in.js";
import { followTrustedDevice, recordTrustedDevice, type DeviceOrigin } from "./two-factor.js";
import {
    originHost,
    originIp,
    originUserAgent,
    originUserAgentBrands,
    originUserAgentPlatform,
    passkeyNameKey,
    passkeyRelyingPartyId,
    PASSKEY_NAME_MAX,
    QR_SIGN_IN_CLIENT_ID,
    QR_SIGN_IN_POLL_SECONDS,
    QR_SIGN_IN_TTL_SECONDS,
    TWO_FACTOR_CODE_ATTEMPTS,
    TWO_FACTOR_CODE_TTL_MINUTES,
    TWO_FACTOR_METHOD_HEADER,
    findConnectionProvider,
    type SecondFactor,
    type SignInMethod
} from "@polaris/core";

/** What a request said about the browser making it, in the shape every device
 *  record here is written from. */
function requestOrigin(headers: Headers | undefined): DeviceOrigin {
    const source = headers ?? new Headers();
    return {
        userAgent: originUserAgent(source),
        userAgentBrands: originUserAgentBrands(source),
        userAgentPlatform: originUserAgentPlatform(source),
        ip: originIp(source),
        host: originHost(source)
    };
}

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
 *
 * Two things are decided inside the ceremony rather than after it. A credential
 * must arrive named, and named something the account is not already using, since
 * the name is the only handle a person has on it when they come to take one away
 * - "Unnamed passkey" three times over is a list nobody can act on. And each
 * assertion stamps the credential it used, so a passkey nobody recognises can be
 * told apart from one that has simply been forgotten.
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
        origin: origins(address),
        registration: {
            afterVerification: async ({ ctx, user }) => {
                await assertPasskeyNameFree(user.id, (ctx.body as { name?: unknown })?.name);
            }
        },
        authentication: {
            afterVerification: async ({ clientData }) => {
                await stampPasskeyUse(clientData.id);
            }
        }
    }) as BetterAuthPlugin;
}

/**
 * Refuse a passkey that arrives unnamed, or named what another of the account's
 * passkeys is already called.
 *
 * Runs before the row is written, so a refusal leaves nothing behind. The
 * comparison ignores case and surrounding space, because two credentials called
 * "iPhone" and "iphone " are two entries a person reading the list cannot tell
 * apart, which is the only thing the rule is protecting.
 *
 * The screen checks the same thing as the field is typed. This is the check that
 * counts: the ceremony is reachable without it.
 */
async function assertPasskeyNameFree(userId: string, supplied: unknown): Promise<void> {
    const name = typeof supplied === "string" ? supplied.trim() : "";
    if (!name) throw new APIError("BAD_REQUEST", { message: "Name this passkey before adding it." });
    if (name.length > PASSKEY_NAME_MAX) {
        throw new APIError("BAD_REQUEST", { message: `Keep the name under ${PASSKEY_NAME_MAX} characters.` });
    }
    // Compared in the application rather than by the database: an account holds a
    // handful of these, and a case-insensitive match is one of the few things the
    // two engines this schema targets do not spell the same way.
    const existing = await prisma.passkey.findMany({ where: { userId }, select: { name: true } });
    const key = passkeyNameKey(name);
    if (existing.some((row) => row.name && passkeyNameKey(row.name) === key)) {
        throw new APIError("BAD_REQUEST", { message: "One of your passkeys is already called that." });
    }
}

/**
 * Note that a credential has just proved a sign-in.
 *
 * Identified by the credential the browser presented, which better-auth has
 * already matched against a stored row and verified the signature of by the time
 * this runs - so it names exactly one passkey and only after that passkey worked.
 *
 * Never fails the sign-in. Somebody is being let in on a credential that
 * verified; a date that could not be written is not a reason to refuse them.
 */
async function stampPasskeyUse(credentialId: string): Promise<void> {
    await prisma.passkey
        .updateMany({ where: { credentialID: credentialId }, data: { lastUsedAt: new Date() } })
        .catch((error: unknown) => console.error("passkey use not recorded:", error));
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
    if (!send) return describeTrustedDevices(gateOtherSignIns(twoFactor({ issuer: "Polaris" })));
    return describeTrustedDevices(
        gateOtherSignIns(
            twoFactor({
                issuer: "Polaris",
                otpOptions: {
                    period: TWO_FACTOR_CODE_TTL_MINUTES,
                    allowedAttempts: TWO_FACTOR_CODE_ATTEMPTS,
                    // The code is a short-lived, low-entropy secret; store it the
                    // way any other one is rather than in the clear next to the
                    // account it opens.
                    storeOTP: "hashed",
                    sendOTP: async ({ user, otp }, ctx) => {
                        const requested = ctx?.headers?.get(TWO_FACTOR_METHOD_HEADER) ?? null;
                        const result = await send({ userId: user.id, requested, code: otp });
                        // better-auth answers send-otp the same way whether or not
                        // this callback managed anything, so a failure is only ever
                        // recorded here. Telling the caller would say which methods
                        // an account has, to somebody who has not finished proving
                        // who they are.
                        if (result.error) console.error("two-factor code not sent:", result.error);
                    }
                }
            })
        )
    );
}

/** What every Polaris cookie is named under. Also the value handed to better-auth
 *  as its cookiePrefix; the two must not drift, so there is one of them. */
const COOKIE_PREFIX = "polaris";

/** better-auth's own name for the cookie naming a remembered browser's pass. */
const TRUST_DEVICE_COOKIE = "trust_device";

/**
 * That cookie as it appears in a jar, both ways it can be named: a deployment
 * with secure cookies on gets the `__Secure-` prefix, and better-auth reads
 * either. Exported because the account page resolves which pass the browser
 * holds from the request's own cookies, outside better-auth's request handling.
 */
export const TRUST_DEVICE_COOKIE_NAMES = [
    `${COOKIE_PREFIX}.${TRUST_DEVICE_COOKIE}`,
    `__Secure-${COOKIE_PREFIX}.${TRUST_DEVICE_COOKIE}`
] as const;

/** The two challenge answers that name themselves. The third - a code Polaris
 *  sent - is named by the channel it went out on, which is settled where it is
 *  sent rather than here. */
const SECOND_FACTOR_BY_PATH: ReadonlyMap<string, SecondFactor> = new Map([
    ["/two-factor/verify-totp", "totp"],
    ["/two-factor/verify-backup-code", "backup-code"]
] as const);

/** Where a sent code is checked. */
const VERIFY_OTP_PATH = "/two-factor/verify-otp";

/** The paths that can hand a browser a pass, by answering the challenge. */
const TWO_FACTOR_VERIFY_PATHS: ReadonlySet<string> = new Set([
    ...SECOND_FACTOR_BY_PATH.keys(),
    VERIFY_OTP_PATH
]);

/**
 * Whether a sign-in on this path has the challenge standing in front of it -
 * which is the same thing as whether it spends a remembered browser's pass,
 * because the pass is what the challenge steps aside for.
 *
 * Every path answers on the path alone except the connected-account one, which
 * carries the answer in its body: whether that way in owes a second step is two
 * settings and a database read away, so the app decides it and says so here (see
 * connection-sign-in.ts). Anything other than an explicit yes reads as no
 * challenge, and the endpoint is unreachable over HTTP, so the only caller that
 * can say either is Polaris itself.
 *
 * Written as a function rather than a set because the emailed-link path is
 * declared further down, next to the hook that widened the challenge to cover it.
 */
function challengedSignIn(path: string, body: unknown): boolean {
    if (path === CONNECTION_SIGN_IN_PATH) {
        return (body as { challenge?: unknown } | undefined)?.challenge === true;
    }
    return path === "/sign-in/email" || CHALLENGED_SIGN_IN_PATHS.has(path);
}

/**
 * Record what a remembered browser was, so the account can list its devices
 * rather than being told a number.
 *
 * A pass is a verification row holding a random identifier, the user id and an
 * expiry - nothing that would let anybody tell one device from another. So
 * Account > Security could offer only "you have three, forget all three", which
 * is the wrong control for the case it exists for: a phone that was lost is one
 * device, and ending the pass on it should not end it on the laptop as well.
 *
 * Two moments to catch. Answering the challenge with "remember this device"
 * mints a pass, and every later sign-in that the pass admits rotates it - old
 * identifier deleted, new one written - so a description that did not follow the
 * rotation would come off the first time the device was used.
 *
 * Both run after better-auth's own handling, and read the pass out of the
 * request cookie, which better-auth does not modify. Neither can fail the
 * request: a sign-in that worked must not be undone because a label could not be
 * written.
 */
function describeTrustedDevices(plugin: BetterAuthPlugin): BetterAuthPlugin {
    return {
        ...plugin,
        hooks: {
            ...plugin.hooks,
            after: [
                ...(plugin.hooks?.after ?? []),
                {
                    matcher: (context) =>
                        TWO_FACTOR_VERIFY_PATHS.has(context.path ?? "") ||
                        challengedSignIn(context.path ?? "", context.body),
                    handler: createAuthMiddleware(async (ctx) => {
                        // Null while a challenge is still in flight: the sign-in
                        // handler creates a session and the two-factor hook takes
                        // it back again, which is the case with no device yet.
                        const user = ctx.context.newSession?.user;
                        if (!user) return;
                        const origin = requestOrigin(ctx.headers);

                        if (TWO_FACTOR_VERIFY_PATHS.has(ctx.path)) {
                            // The only thing that mints a pass. Anything else on
                            // these paths is somebody proving themselves without
                            // asking to be remembered.
                            if ((ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice !== true) return;
                            await recordTrustedDevice(user.id, origin);
                            return;
                        }

                        // A rotation only happens for an account that has the
                        // challenge armed; for any other, a cookie left over from
                        // before is not a pass and better-auth ignored it.
                        if ((user as { twoFactorEnabled?: unknown }).twoFactorEnabled !== true) return;
                        const cookie = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE);
                        // False is a cookie whose signature did not check out,
                        // which better-auth treats as no cookie at all.
                        const held = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
                        const previous = typeof held === "string" ? held.split("!")[1] : undefined;
                        if (previous) await followTrustedDevice(user.id, previous, origin);
                    })
                }
            ]
        }
    };
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
 * The sign-ins better-auth's own plugin does not watch, and that raise the
 * second-factor challenge regardless of what anybody has configured.
 *
 * One entry, and it is the one that stands in for the password without anything
 * standing behind it: an emailed link proves a mailbox and nothing else, so an
 * account whose mail is read is an account that is entered. The connected-account
 * path is challenged on the same hook but decides per sign-in (see
 * challengedSignIn), because the account it defers to has gates of its own.
 */
const CHALLENGED_SIGN_IN_PATHS: ReadonlySet<string> = new Set([MAGIC_LINK_VERIFY_PATH]);

/**
 * Make those sign-ins raise the second-factor challenge too.
 *
 * better-auth's two-factor plugin only watches the credential sign-in paths, so
 * on its own an emailed link hands an account with an armed authenticator a full
 * session - no password and no code - which makes the mailbox a single point of
 * failure for exactly the accounts that asked for it not to be. The hook's own
 * handler is path-agnostic (it takes back the session the endpoint just created,
 * then starts the challenge), so covering another path is a matter of widening
 * what it matches; reimplementing the challenge here instead would leave two
 * copies of it to drift apart.
 *
 * A version of better-auth that moved the hook throws at start-up rather than
 * quietly reopening the path - this is the only thing closing it, and the shape
 * it depends on is pinned by a test.
 */
function gateOtherSignIns(plugin: BetterAuthPlugin): BetterAuthPlugin {
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
                              matches(context) || challengedSignIn(context.path ?? "", context.body)
                      }
                    : hook
            )
        }
    };
}

/** The paths that end a sign-in by issuing a session, and what each one proves
 *  about the person who reached it. */
const SIGN_IN_METHOD_BY_PATH: ReadonlyMap<string, SignInMethod> = new Map([
    ["/sign-in/email", "password"],
    [MAGIC_LINK_VERIFY_PATH, "email-link"],
    ["/passkey/verify-authentication", "passkey"],
    [DEVICE_TOKEN_PATH, "qr-code"]
] as const);

/**
 * The service that proved a sign-in with a linked account, which is the one
 * method the path does not name on its own - one endpoint answers for every
 * provider. Read from the request the app made rather than from a lookup, and
 * checked against the catalog, so an unrecognized value reads as a sign-in with
 * no method rather than as a label nobody can place.
 */
function connectionSignInMethod(path: string, body: unknown): SignInMethod | undefined {
    if (path !== CONNECTION_SIGN_IN_PATH) return undefined;
    const provider = (body as { provider?: unknown } | undefined)?.provider;
    return typeof provider === "string" ? findConnectionProvider(provider)?.slug : undefined;
}

/**
 * Record how each sign-in proved itself, for the account's own session list.
 *
 * Registered as the instance's own after-hook rather than on a plugin, because
 * the methods it covers belong to four different ones - and because running
 * before every plugin hook is exactly what it needs: on a credential sign-in the
 * two-factor plugin takes the session back again when a challenge is due, and
 * this has to see the session while it is still there to know whose sign-in it
 * was. A better-auth that stopped running it first would cost the first factor on
 * a challenged sign-in - "authenticator app" with nothing in front of it - rather
 * than describe one wrongly, which is the direction to fail in.
 *
 * That is also why a password sign-in on an account with the challenge armed is
 * noted here as having skipped it on a remembered browser. At this point nobody
 * knows yet whether the challenge will be raised; if it is, answering it
 * overwrites this note, and if it is abandoned the note expires uncollected. The
 * only sign-in this description survives to is the one it describes.
 */
const recordSignInMethod = createAuthMiddleware(async (ctx) => {
    // Null on a wrong password, a refused code, and while a challenge is in
    // flight - all of them sign-ins that issued nothing to describe.
    const user = ctx.context.newSession?.user;
    if (!user) return;

    const method = SIGN_IN_METHOD_BY_PATH.get(ctx.path) ?? connectionSignInMethod(ctx.path, ctx.body);
    if (method) {
        const armed = (user as { twoFactorEnabled?: unknown }).twoFactorEnabled === true;
        // A passkey, a scanned code and a connected account this deployment does
        // not challenge are never asked for a second step, so an armed factor
        // says nothing about how they got in. The sign-ins that are challenged
        // are exactly the ones that spend a remembered browser's pass, which is
        // the same question asked from the other side.
        const challengeable = challengedSignIn(ctx.path, ctx.body);
        await noteSignIn(user.id, {
            method,
            secondFactor: challengeable && armed ? "trusted-device" : null
        });
        return;
    }

    const answered = SECOND_FACTOR_BY_PATH.get(ctx.path);
    if (answered) {
        await noteSecondFactor(user.id, answered);
        return;
    }
    if (ctx.path === VERIFY_OTP_PATH) await noteSentCodeAnswered(user.id);
});

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
    const plugins: BetterAuthPlugin[] = [
        twoFactorPlugin(options),
        deviceAuthorizationPlugin(),
        connectionSignInPlugin()
    ];
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
    //
    // The loopback address is one of them. The edge routes it - the dashboard's
    // router matches any bare IPv4 host - and it is what somebody is given when
    // the local names do not resolve for them, which on Windows is the usual case
    // because writing them needs Administrator. Without it here the first sign-in
    // works (no cookie yet, so the origin is never checked) and every request
    // after it is refused as coming from somewhere else: signing out, signing in
    // again, arming a second factor, changing a password.
    const fixedOrigins = Array.from(
        new Set([
            env.POLARIS_APP_URL,
            ...origins(`${localName}.local`),
            `http://${localName}`,
            ...origins("127.0.0.1")
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
        hooks: { after: recordSignInMethod },
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
            cookiePrefix: COOKIE_PREFIX,
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
            const refusal = await refuseProtectedEndpoint(shared, request);
            if (refusal) return refusal;
            const address = await resolvePasskeyAddress(request, options);
            const response = await instanceFor(address).handler(request);
            return address ? recordPasskeyOrigin(request, response, address) : response;
        }
    };
}

/**
 * The better-auth endpoints that change what protects an account, rather than
 * using it.
 *
 * These are the ones the account page's own actions have no say over: the
 * ceremony that attaches a passkey, the ones that rename or remove one, and
 * arming or dropping the authenticator. Everything equivalent that goes through
 * a server action is guarded there; this is the same rule applied where the
 * browser talks to better-auth directly.
 *
 * Minting backup codes is listed even though Polaris asks for them through a
 * server action that already refuses a waiting device: the route stays reachable
 * from the browser, and a set of codes is a set of ways in whichever way it was
 * asked for.
 */
const PROTECTED_ENDPOINTS: ReadonlySet<string> = new Set([
    "/passkey/generate-register-options",
    "/passkey/verify-registration",
    "/passkey/delete-passkey",
    "/passkey/update-passkey",
    "/two-factor/enable",
    "/two-factor/disable",
    "/two-factor/generate-backup-codes"
]);

/** Registering a passkey is the one that also wants the password proved. The
 *  others already ask for it, or only ever take something away. */
const NEEDS_PASSWORD: ReadonlySet<string> = new Set([
    "/passkey/generate-register-options",
    "/passkey/verify-registration"
]);

/** A refusal in the shape a better-auth client reads an error from. */
function refused(message: string, code: string): Response {
    return new Response(JSON.stringify({ code, message }), {
        status: 403,
        headers: { "content-type": "application/json" }
    });
}

/**
 * Stop a request that would change the account's protection when this browser is
 * not entitled to: it has not proved the password, or it is a device still
 * serving the account's new-device wait.
 *
 * Adding a passkey is adding a way in, and better-auth's ceremony proves the
 * device rather than the account - so an open session left on a borrowed screen
 * was enough to attach a permanent credential to it. Asking for the password
 * first is what makes that a deliberate act. It is proved through a server action
 * beforehand and only checked here, because the ceremony's own request is the
 * browser's to shape and there is nowhere in it to carry one.
 *
 * Returns null for everything else, including every unauthenticated request:
 * better-auth refuses those itself, and answering them here would only invent a
 * second opinion about who is signed in.
 */
export async function refuseProtectedEndpoint(auth: Auth, request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const endpoint = [...PROTECTED_ENDPOINTS].find((known) => path.endsWith(known));
    if (!endpoint) return null;

    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (!session) return null;

    const standing = await sessionDeviceStanding(session.user.id, session.session.id);
    if (!standing.settled) {
        return refused(newDeviceWaitMessage(standing), "NEW_DEVICE_WAITING");
    }
    if (NEEDS_PASSWORD.has(endpoint) && !(await passwordConfirmed(session.user.id, session.session.id))) {
        return refused("Confirm your password before adding a passkey.", "PASSWORD_NOT_CONFIRMED");
    }
    return null;
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
 * Record where a newly registered passkey came from: the address it is bound to,
 * and the browser that created it.
 *
 * The plugin's own row carries neither. Without the address the account page
 * cannot say where a passkey works and the sign-in page cannot tell whether
 * offering one here would do anything but raise a prompt that fails. Without the
 * browser a passkey cannot be shown beside the sessions and the remembered pass
 * of the device holding it, which is what somebody deciding what to take away
 * from a device they no longer have is looking for.
 *
 * The address is read from the response rather than reported by the browser
 * afterwards, so the binding is whatever the server actually issued the
 * challenge for. The user-agent, the brands and the address the request came
 * from can only ever be what the caller claimed, which is why they are labels
 * here and nowhere near a decision.
 *
 * The name is settled here too. better-auth stores what the browser sent
 * verbatim, and the ceremony that accepted it compared a trimmed form, so
 * writing the trimmed form back is what keeps the stored name and the name the
 * uniqueness rule was applied to the same string.
 */
export async function recordPasskeyOrigin(
    request: Request,
    response: Response,
    address: string
): Promise<Response> {
    if (response.status !== 200) return response;
    if (!new URL(request.url).pathname.endsWith("/passkey/verify-registration")) return response;
    const created: unknown = await response.clone().json().catch(() => null);
    const id = (created as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return response;
    const name = (created as { name?: unknown }).name;
    await prisma.passkey
        .update({
            where: { id },
            data: {
                rpId: passkeyRelyingPartyId(address),
                userAgent: originUserAgent(request.headers) ?? null,
                userAgentBrands: originUserAgentBrands(request.headers) ?? null,
                userAgentPlatform: originUserAgentPlatform(request.headers) ?? null,
                ip: originIp(request.headers) ?? null,
                ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {})
            }
        })
        // The passkey exists and works either way; only the label for it is lost,
        // so this must not turn a successful registration into a failed request.
        .catch((error: unknown) => console.error("passkey origin not recorded:", error));
    return response;
}
