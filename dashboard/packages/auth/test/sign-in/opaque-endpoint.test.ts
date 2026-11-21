/**
 * The OPAQUE password sign-in endpoint: sealed against the network exactly like
 * the connected-account one, and covered by the second-factor challenge exactly
 * like `/sign-in/email` - so an account with an authenticator armed is still
 * asked for its code however it proved its password.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { OPAQUE_SIGN_IN_PATH } from "../../src/opaque-sign-in.js";

const PUBLISHED = "https://polaris.example.com";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

interface HookedPlugin {
    id: string;
    endpoints?: Record<string, unknown>;
    hooks?: { after?: { matcher: (context: { path: string; body?: unknown }) => boolean }[] };
}

function plugin(instance: { options: { plugins?: unknown[] } }, id: string): HookedPlugin {
    const found = ((instance.options.plugins ?? []) as HookedPlugin[]).find((entry) => entry.id === id);
    if (!found) throw new Error(`the ${id} plugin is not registered`);
    return found;
}

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = PUBLISHED;
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

describe("signing in with a password proved over OPAQUE", () => {
    it("exposes the one endpoint the app drives it through", () => {
        const endpoints = plugin(authModule.createAuth(), "polaris-opaque-sign-in").endpoints ?? {};
        expect(Object.keys(endpoints)).toEqual(["polarisOpaqueSignIn"]);
    });

    it("answers an HTTP caller with nothing at all, whatever it sends", async () => {
        const auth = authModule.createAuth();
        for (const body of [{ userId: "somebody-else" }, {}, "not json"]) {
            const response = await auth.handler(
                new Request(`${PUBLISHED}/api/auth${OPAQUE_SIGN_IN_PATH}`, {
                    method: "POST",
                    headers: { "content-type": "application/json", origin: PUBLISHED },
                    body: JSON.stringify(body)
                })
            );
            expect(response.status).toBe(404);
        }
    });

    it("is challenged by the second factor exactly like the password sign-in", () => {
        const hooks = plugin(authModule.createAuth(), "two-factor").hooks?.after ?? [];
        const challenges = (path: string) => hooks.some((hook) => hook.matcher({ path, body: {} }));
        expect(challenges("/sign-in/email")).toBe(true);
        expect(challenges(OPAQUE_SIGN_IN_PATH)).toBe(true);
    });
});
