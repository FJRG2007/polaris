/**
 * The origin check hands the request to the app's `configuredHosts`.
 *
 * A sign-in on this machine's IP, typed by hand, is trusted from the request it
 * arrives in (the app decides which addresses qualify), so the origin check has
 * to pass that request on. Pinned on better-auth's own handler, on an endpoint
 * that reaches no database before the check: a request from the address it
 * reached gets past the origin check, and one from any other origin is still
 * refused.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PUBLISHED = "https://polaris.example.com";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

const testEnv = { NODE_ENV: process.env.NODE_ENV, TEST: process.env.TEST };

beforeAll(async () => {
    // better-auth switches the origin check off under NODE_ENV=test or TEST,
    // read once when it loads - so it loads here as it does in production.
    process.env.NODE_ENV = "production";
    delete process.env.TEST;
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:1/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = PUBLISHED;
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

afterAll(() => {
    process.env.NODE_ENV = testEnv.NODE_ENV;
    if (testEnv.TEST !== undefined) process.env.TEST = testEnv.TEST;
});

/** The host a request was sent to, as an app that trusts it would answer. */
async function hostOf(request?: Request): Promise<string[]> {
    const host = request?.headers.get("host");
    return host ? [host] : [];
}

async function signOut(origin: string, host: string): Promise<{ status: number; body: string }> {
    const auth = authModule.createAuth({ configuredHosts: hostOf });
    const response = await auth.handler(
        new Request(`https://${host}/api/auth/sign-out`, {
            method: "POST",
            // A browser with a cookie for this address, which is when the
            // origin is checked at all.
            headers: { "content-type": "application/json", origin, host, cookie: "seen=1" },
            body: "{}"
        })
    );
    return { status: response.status, body: await response.text() };
}

describe("origins from the request", () => {
    it("lets a request from the address the request reached past the origin check", async () => {
        const answer = await signOut("https://192.168.1.172", "192.168.1.172");
        expect(answer.body).not.toMatch(/invalid origin/i);
        expect(answer.status).not.toBe(403);
    });

    it("still refuses a request from any other origin", async () => {
        const answer = await signOut("https://evil.example.com", "192.168.1.172");
        expect(answer.status).toBe(403);
        expect(answer.body).toMatch(/invalid origin/i);
    });
});
