/**
 * The passkey relying party a request is served with. A credential is bound to
 * one address, and this deployment answers on several, so what matters is that
 * the address in hand is the one the challenge is issued for - and that only the
 * addresses this deployment actually answers on can produce one.
 */

import { beforeAll, describe, expect, it } from "vitest";

const PUBLISHED = "https://polaris.example.com";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

/** The passkey plugin's options on an instance, or null when it has none - an
 *  address that cannot be a relying party leaves the plugin unregistered. */
function relyingParty(instance: { options: { plugins?: unknown[] } }) {
    const plugins = (instance.options.plugins ?? []) as { id: string; options?: unknown }[];
    const found = plugins.find((plugin) => plugin.id === "passkey");
    return (found?.options ?? null) as { rpID: string; origin: string[] } | null;
}

function requestFrom(headers: Record<string, string>): Request {
    return new Request("https://polaris.example.com/api/auth/passkey/generate-register-options", {
        headers
    });
}

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = PUBLISHED;
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

describe("createAuth", () => {
    it("binds passkeys to the published address by default", () => {
        expect(relyingParty(authModule.createAuth())).toEqual({
            rpID: "polaris.example.com",
            rpName: "Polaris",
            origin: ["https://polaris.example.com", "http://polaris.example.com"]
        });
    });

    it("binds them to the address it is given, port and all", () => {
        expect(relyingParty(authModule.createAuth({}, "polaris.local:3000"))).toEqual({
            rpID: "polaris.local",
            rpName: "Polaris",
            origin: ["https://polaris.local:3000", "http://polaris.local:3000"]
        });
    });

    it("leaves passkeys unregistered on an address that cannot hold one", () => {
        expect(relyingParty(authModule.createAuth({}, "192.168.1.40:3000"))).toBeNull();
    });
});

describe("resolvePasskeyAddress", () => {
    it("accepts the local names and the published one", async () => {
        const { resolvePasskeyAddress } = authModule;
        expect(await resolvePasskeyAddress(requestFrom({ host: "polaris.local" }), {})).toBe(
            "polaris.local"
        );
        expect(await resolvePasskeyAddress(requestFrom({ host: "polaris:3000" }), {})).toBe(
            "polaris:3000"
        );
        expect(await resolvePasskeyAddress(requestFrom({ host: "polaris.example.com" }), {})).toBe(
            "polaris.example.com"
        );
    });

    it("accepts a domain configured after install", async () => {
        const options = { configuredHosts: async () => ["files.example.com"] };
        const { resolvePasskeyAddress } = authModule;
        expect(await resolvePasskeyAddress(requestFrom({ host: "files.example.com" }), options)).toBe(
            "files.example.com"
        );
    });

    it("prefers the forwarded host the edge sets", async () => {
        const request = requestFrom({ host: "polaris:3000", "x-forwarded-host": "polaris.local" });
        expect(await authModule.resolvePasskeyAddress(request, {})).toBe("polaris.local");
    });

    it("refuses a host this deployment does not answer on", async () => {
        expect(await authModule.resolvePasskeyAddress(requestFrom({ host: "evil.example" }), {})).toBeNull();
    });

    it("refuses an address that could never hold a passkey", async () => {
        const { resolvePasskeyAddress } = authModule;
        expect(await resolvePasskeyAddress(requestFrom({ host: "192.168.1.40:3000" }), {})).toBeNull();
        expect(await resolvePasskeyAddress(requestFrom({ host: "polaris.local:notaport" }), {})).toBeNull();
    });
});
