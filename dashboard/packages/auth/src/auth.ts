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
 * had. A request's own Host header is never trusted: it is the attacker's to set.
 */

import { randomUUID } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { magicLink, twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import {
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
 * The sign-in methods beyond a password: a TOTP second factor with single-use
 * backup codes, passkeys, and - on a deployment that has a mail sender - sign-in
 * by emailed link. Verification is required before the authenticator is armed,
 * so a user who mis-scans the QR cannot lock themselves out.
 *
 * Typed as the plugin base rather than left inferred: the plugin's endpoint
 * types embed better-auth's own nested zod, which this package cannot name in
 * its emitted declarations. The browser client declares the two-factor paths it
 * calls, so nothing loses type safety - the flow runs through @polaris/web's
 * auth client, not through auth.api here.
 */
/**
 * WebAuthn binds a credential to one registrable domain, so a deployment reached
 * on several names has to pick one. The app URL is that one: it is the address an
 * operator publishes and the only one guaranteed to be reachable from outside.
 *
 * The practical consequence is worth stating plainly - a passkey registered on
 * the domain does not work when the same Polaris is opened as polaris.local, and
 * cannot be made to. Every other sign-in method still does.
 */
function passkeyRelyingParty(appUrl: string): { rpID: string; origin: string } | null {
    try {
        const url = new URL(appUrl);
        return { rpID: url.hostname, origin: url.origin };
    } catch {
        return null;
    }
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
    if (!send) return twoFactor({ issuer: "Polaris" });
    return twoFactor({
        issuer: "Polaris",
        otpOptions: {
            period: TWO_FACTOR_CODE_TTL_MINUTES,
            allowedAttempts: TWO_FACTOR_CODE_ATTEMPTS,
            // The code is a short-lived, low-entropy secret; store it the way any
            // other one is rather than in the clear next to the account it opens.
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
    });
}

function buildPlugins(options: AuthOptions, appUrl: string, trusted: readonly string[]): BetterAuthPlugin[] {
    const plugins: BetterAuthPlugin[] = [twoFactorPlugin(options)];
    const relyingParty = passkeyRelyingParty(appUrl);
    if (relyingParty) {
        plugins.push(
            passkey({
                rpID: relyingParty.rpID,
                rpName: "Polaris",
                // Pinned rather than left for the client to supply: an origin the
                // caller chooses is an origin an attacker chooses.
                origin: Array.from(new Set([relyingParty.origin, ...trusted]))
            }) as BetterAuthPlugin
        );
    }
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

export function createAuth(options: AuthOptions = {}) {
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
        plugins: buildPlugins(options, env.POLARIS_APP_URL, fixedOrigins),
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
