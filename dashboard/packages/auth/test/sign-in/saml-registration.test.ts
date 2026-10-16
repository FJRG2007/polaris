/**
 * The runtime auth factory carries the SAML plugin and its password rule. The
 * flows themselves are exercised in saml-sso.test.ts; this only proves the
 * instance the app serves is built with them, so dropping the plugin from the
 * factory fails here rather than leaving SSO silently unreachable.
 */

import { beforeAll, describe, expect, it } from "vitest";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

type Hook = { matcher: (context: { path?: string }) => boolean };
type Plugin = { id: string; hooks?: { before?: Hook[] } };

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = "https://polaris.example.com";
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

function ssoPlugin(): Plugin | undefined {
    const plugins = (authModule.createAuth().options.plugins ?? []) as Plugin[];
    return plugins.find((plugin) => plugin.id === "sso");
}

function hooked(plugin: Plugin | undefined, path: string): boolean {
    return (plugin?.hooks?.before ?? []).some((hook) => hook.matcher({ path }));
}

describe("createAuth", () => {
    it("registers the SSO plugin", () => {
        expect(ssoPlugin()).toBeDefined();
    });

    it("guards password sign-in, return addresses, responses and provider management", () => {
        const plugin = ssoPlugin();
        for (const path of ["/sign-in/email", "/sign-in/magic-link", "/sign-in/sso", "/sso/saml2/sp/acs/:providerId", "/sso/register"]) {
            expect(hooked(plugin, path), path).toBe(true);
        }
    });
});
