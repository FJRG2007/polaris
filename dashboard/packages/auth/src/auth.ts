/**
 * better-auth configuration for Polaris. Exposed as a factory rather than a
 * module-level singleton so importing this package never reads the environment
 * or constructs a client at load time - the app calls createAuth() once, where
 * POLARIS_* env is guaranteed present.
 *
 * Email/password is the only enabled method for now. The custom isAdmin field is
 * mirrored onto the session user for the admin double-gate, but is input:false so
 * it can never be set through the public sign-up payload - only server code
 * flips it. trustedOrigins is pinned to the app URL to blunt the open-redirect
 * and origin-check classes of issue this library has historically had.
 */

import { randomUUID } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";

/** Session lifetime: 7 days, refreshed at most once per day. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE = 60 * 60 * 24;

/**
 * TOTP second factor with single-use backup codes. Verification is required
 * before the factor is armed, so a user who mis-scans the QR cannot lock
 * themselves out. Email OTP stays unconfigured on purpose (Polaris has no
 * outbound mail), which leaves those endpoints inert.
 *
 * Typed as the plugin base rather than left inferred: the plugin's endpoint
 * types embed better-auth's own nested zod, which this package cannot name in
 * its emitted declarations. The browser client declares the two-factor paths it
 * calls, so nothing loses type safety - the flow runs through @polaris/web's
 * auth client, not through auth.api here.
 */
const PLUGINS: BetterAuthPlugin[] = [twoFactor({ issuer: "Polaris" })];

export function createAuth() {
    const env = loadEnv();
    const localName = env.POLARIS_LOCAL_HOSTNAME;
    // Trust the public origin plus the local-network names (homeassistant.local
    // style) so the dashboard works whether reached by domain, polaris.local, or
    // bare polaris. Deduplicated in case the app URL is already one of them.
    const trustedOrigins = Array.from(
        new Set([
            env.POLARIS_APP_URL,
            `http://${localName}.local`,
            `https://${localName}.local`,
            `http://${localName}`
        ])
    );
    return betterAuth({
        appName: "Polaris",
        secret: env.POLARIS_AUTH_SECRET,
        baseURL: env.POLARIS_APP_URL,
        trustedOrigins,
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
        plugins: PLUGINS,
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
