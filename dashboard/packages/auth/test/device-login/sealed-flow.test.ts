/**
 * The QR sign-in flow must not be reachable over the network.
 *
 * better-auth's device-authorization plugin is written for a TV or a CLI: anyone
 * may open a code, approving one needs nothing but a session, and the exchange
 * answers with a bearer token. Polaris uses it as the wiring between two of its
 * own screens and puts the rules somewhere else entirely - a rate limit on
 * opening a code, the quick-unlock PIN on approving one - so every endpoint is
 * closed to HTTP and driven from server actions instead.
 *
 * That seal is invisible from the outside: the feature works either way. What is
 * pinned here is that the endpoints exist under the names Polaris calls, that the
 * seal covers all of them, and that a request off the wire gets nothing.
 */

import { beforeAll, describe, expect, it } from "vitest";

const PUBLISHED = "https://polaris.example.com";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

interface HookedPlugin {
    id: string;
    endpoints?: Record<string, unknown>;
    hooks?: {
        before?: { matcher: (context: { path: string }) => boolean }[];
        after?: { matcher: (context: { path: string }) => boolean }[];
    };
}

function devicePlugin(instance: { options: { plugins?: unknown[] } }): HookedPlugin {
    const plugins = (instance.options.plugins ?? []) as HookedPlugin[];
    const plugin = plugins.find((entry) => entry.id === "device-authorization");
    if (!plugin) throw new Error("the device-authorization plugin is not registered");
    return plugin;
}

const DEVICE_PATHS = ["/device/code", "/device", "/device/approve", "/device/deny", "/device/token"];

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = PUBLISHED;
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

describe("the QR sign-in flow", () => {
    it("exposes the endpoints Polaris drives it through", () => {
        const endpoints = devicePlugin(authModule.createAuth()).endpoints ?? {};
        expect(Object.keys(endpoints).sort()).toEqual([
            "deviceApprove",
            "deviceCode",
            "deviceDeny",
            "deviceToken",
            "deviceVerify"
        ]);
    });

    it("seals every one of its paths against a request off the wire", () => {
        const hooks = devicePlugin(authModule.createAuth()).hooks?.before ?? [];
        for (const path of DEVICE_PATHS) {
            expect(hooks.some((hook) => hook.matcher({ path }))).toBe(true);
        }
    });

    it("leaves the rest of the auth surface alone", () => {
        const hooks = devicePlugin(authModule.createAuth()).hooks?.before ?? [];
        for (const path of ["/sign-in/email", "/sign-out", "/get-session"]) {
            expect(hooks.some((hook) => hook.matcher({ path }))).toBe(false);
        }
    });

    it("turns the approved exchange into a session cookie", () => {
        const hooks = devicePlugin(authModule.createAuth()).hooks?.after ?? [];
        expect(hooks.some((hook) => hook.matcher({ path: "/device/token" }))).toBe(true);
        expect(hooks.some((hook) => hook.matcher({ path: "/device/code" }))).toBe(false);
    });

    it("answers an HTTP caller with nothing at all", async () => {
        const auth = authModule.createAuth();
        const response = await auth.handler(
            new Request(`${PUBLISHED}/api/auth/device/code`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: PUBLISHED },
                body: JSON.stringify({ client_id: "polaris-dashboard" })
            })
        );
        expect(response.status).toBe(404);
    });
});
