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

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { bootstrapFirstAdmin } from "./roles.js";

/** Session lifetime: 7 days, refreshed at most once per day. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE = 60 * 60 * 24;

export function createAuth() {
    const env = loadEnv();
    return betterAuth({
        appName: "Polaris",
        secret: env.POLARIS_AUTH_SECRET,
        baseURL: env.POLARIS_APP_URL,
        trustedOrigins: [env.POLARIS_APP_URL],
        database: prismaAdapter(prisma, { provider: env.POLARIS_DB_PROVIDER }),
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: false,
            minPasswordLength: 10
        },
        session: {
            expiresIn: SESSION_MAX_AGE,
            updateAge: SESSION_UPDATE_AGE
        },
        user: {
            additionalFields: {
                // Server-only flag; never accepted from client input.
                isAdmin: { type: "boolean", required: false, defaultValue: false, input: false }
            }
        },
        advanced: {
            cookiePrefix: "polaris"
        },
        databaseHooks: {
            user: {
                create: {
                    // The first account to register becomes the operator, and the
                    // built-in roles are seeded on that first sign-up.
                    after: async (user) => {
                        await bootstrapFirstAdmin(user.id);
                    }
                }
            }
        }
    });
}

export type Auth = ReturnType<typeof createAuth>;
