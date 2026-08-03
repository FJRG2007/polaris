/**
 * An emailed sign-in link must not be a way past the second factor.
 *
 * better-auth's two-factor plugin only watches the credential sign-in paths, so
 * Polaris widens that hook to cover the link as well (see gateEmailedLink). The
 * hole it closes is invisible from the outside - the link simply works - so what
 * is pinned here is the shape the widening depends on: an upgrade that moves or
 * renames the hook has to fail here rather than quietly hand an armed account a
 * full session for a click in a mailbox.
 */

import { beforeAll, describe, expect, it } from "vitest";

const PUBLISHED = "https://polaris.example.com";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

/** Which paths the two-factor plugin's after-hooks claim, on a built instance. */
function twoFactorMatchers(instance: { options: { plugins?: unknown[] } }) {
    const plugins = (instance.options.plugins ?? []) as {
        id: string;
        hooks?: { after?: { matcher: (context: { path: string }) => boolean }[] };
    }[];
    const plugin = plugins.find((entry) => entry.id === "two-factor");
    const hooks = plugin?.hooks?.after ?? [];
    return (path: string) => hooks.some((hook) => hook.matcher({ path }));
}

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = PUBLISHED;
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

describe("the second-factor gate", () => {
    it("covers the emailed link as well as the password", () => {
        const claims = twoFactorMatchers(authModule.createAuth());
        expect(claims("/sign-in/email")).toBe(true);
        expect(claims(authModule.MAGIC_LINK_VERIFY_PATH)).toBe(true);
    });

    it("covers it on a deployment that can send codes by message", () => {
        const claims = twoFactorMatchers(
            authModule.createAuth({ sendTwoFactorCode: async () => ({}) })
        );
        expect(claims("/sign-in/email")).toBe(true);
        expect(claims(authModule.MAGIC_LINK_VERIFY_PATH)).toBe(true);
    });

    it("leaves paths that issue no session alone", () => {
        const claims = twoFactorMatchers(authModule.createAuth());
        expect(claims("/sign-out")).toBe(false);
        expect(claims("/two-factor/send-otp")).toBe(false);
    });
});
