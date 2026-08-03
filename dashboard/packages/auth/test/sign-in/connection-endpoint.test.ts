/**
 * Signing in with a linked account must not be reachable over the network.
 *
 * The endpoint takes a user id and issues that account a session. Everything
 * that decides whether it may - which service, whose link, whether the owner and
 * the operator both allow it - happens in the app before it is called, so an
 * endpoint anybody could POST to would be a way past all of it at once.
 *
 * The seal is invisible from the outside: signing in works either way. What is
 * pinned here is that the endpoint exists under the name the app calls, and that
 * a request off the wire gets nothing.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { CONNECTION_SIGN_IN_PATH } from "../../src/connection-sign-in.js";

const PUBLISHED = "https://polaris.example.com";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

function connectionPlugin(instance: { options: { plugins?: unknown[] } }) {
    const plugins = (instance.options.plugins ?? []) as { id: string; endpoints?: Record<string, unknown> }[];
    const plugin = plugins.find((entry) => entry.id === "polaris-connection-sign-in");
    if (!plugin) throw new Error("the connection sign-in plugin is not registered");
    return plugin;
}

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = PUBLISHED;
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

describe("signing in with a linked account", () => {
    it("exposes the one endpoint the app drives it through", () => {
        const endpoints = connectionPlugin(authModule.createAuth()).endpoints ?? {};
        expect(Object.keys(endpoints)).toEqual(["polarisConnectionSignIn"]);
    });

    it("answers an HTTP caller with nothing at all", async () => {
        const auth = authModule.createAuth();
        const response = await auth.handler(
            new Request(`${PUBLISHED}/api/auth${CONNECTION_SIGN_IN_PATH}`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: PUBLISHED },
                body: JSON.stringify({ userId: "somebody-else", provider: "github" })
            })
        );
        expect(response.status).toBe(404);
    });
});
