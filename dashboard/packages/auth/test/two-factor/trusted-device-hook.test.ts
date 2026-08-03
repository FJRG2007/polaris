/**
 * Where the description of a remembered device gets written.
 *
 * Polaris hangs a hook off the two-factor plugin on the paths that mint a pass
 * and the paths that spend one (see describeTrustedDevices). Nothing visible
 * breaks if those paths stop matching - sign-in still works, the pass still
 * works - and the only symptom is that Account > Sessions gradually fills with
 * devices it cannot name. So the paths are pinned here, where a better-auth
 * upgrade that renames one fails loudly instead.
 */

import { beforeAll, describe, expect, it } from "vitest";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

/** Every after-hook the two-factor plugin carries, on a built instance. */
function claims(instance: { options: { plugins?: unknown[] } }): (path: string) => number {
    const plugins = (instance.options.plugins ?? []) as {
        id: string;
        hooks?: { after?: { matcher: (context: { path: string }) => boolean }[] };
    }[];
    const hooks = plugins.find((entry) => entry.id === "two-factor")?.hooks?.after ?? [];
    return (path) => hooks.filter((hook) => hook.matcher({ path })).length;
}

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = "https://polaris.example.com";
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

describe("the hook that describes a remembered device", () => {
    it("watches every way a challenge can be answered", () => {
        const claimed = claims(authModule.createAuth());
        expect(claimed("/two-factor/verify-totp")).toBe(1);
        expect(claimed("/two-factor/verify-otp")).toBe(1);
        expect(claimed("/two-factor/verify-backup-code")).toBe(1);
    });

    it("watches the sign-ins that spend a pass, alongside the gate already there", () => {
        const claimed = claims(authModule.createAuth());
        // Two hooks: better-auth's own, which rotates the pass, and this one,
        // which follows the rotation. Both are needed and they run in that order.
        expect(claimed("/sign-in/email")).toBe(2);
        expect(claimed(authModule.MAGIC_LINK_VERIFY_PATH)).toBe(2);
    });

    it("is there on a deployment that can send codes by message too", () => {
        const claimed = claims(authModule.createAuth({ sendTwoFactorCode: async () => ({}) }));
        expect(claimed("/two-factor/verify-totp")).toBe(1);
        expect(claimed("/sign-in/email")).toBe(2);
    });

    it("leaves alone the paths that hand out no pass", () => {
        const claimed = claims(authModule.createAuth());
        expect(claimed("/two-factor/send-otp")).toBe(0);
        expect(claimed("/two-factor/disable")).toBe(0);
        expect(claimed("/sign-out")).toBe(0);
    });
});
