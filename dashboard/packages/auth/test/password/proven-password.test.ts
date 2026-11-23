/**
 * A password proven over OPAQUE, accepted once by the account's password check
 * (`withProvenPassword`, src/proven-password.ts): only inside the scope, only
 * with the stand-in it handed out, only for the hash it was made for, once,
 * and for 30 s at most.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type AuthModule = typeof import("../../src/auth.js");
type ProvenModule = typeof import("../../src/proven-password.js");
let authModule: AuthModule;
let proven: ProvenModule;

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:1/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = "https://polaris.example.com";
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
    proven = await import("../../src/proven-password.js");
});

afterEach(() => {
    vi.useRealTimers();
});

describe("a proven password", () => {
    it("opens the check it was made for, exactly once", async () => {
        const hasher = authModule.passwordHasher({});
        const hash = await hasher.hash("a secret nobody keeps");
        const answers = await proven.withProvenPassword(hash, async (standIn) => [
            await hasher.verify({ hash, password: standIn }),
            await hasher.verify({ hash, password: standIn })
        ]);
        expect(answers).toEqual([true, false]);
    });

    it("never opens another hash, another password, or anything outside its scope", async () => {
        const hasher = authModule.passwordHasher({});
        const hash = await hasher.hash("a secret nobody keeps");
        const other = await hasher.hash("somebody else's");
        let leaked = "";
        await proven.withProvenPassword(hash, async (standIn) => {
            leaked = standIn;
            expect(await hasher.verify({ hash: other, password: standIn })).toBe(false);
            expect(await hasher.verify({ hash, password: "typed by hand" })).toBe(false);
        });
        // The same stand-in, outside the scope - as another request would be.
        expect(await hasher.verify({ hash, password: leaked })).toBe(false);
        // A scope of its own never accepts another scope's stand-in.
        await proven.withProvenPassword(hash, async () => {
            expect(await hasher.verify({ hash, password: leaked })).toBe(false);
        });
    });

    it("expires 30 s after the proof", async () => {
        const hash = await authModule.passwordHasher({}).hash("a secret nobody keeps");
        vi.useFakeTimers({ toFake: ["Date"] });
        const opened = await proven.withProvenPassword(hash, async (standIn) => {
            vi.setSystemTime(Date.now() + proven.PROVEN_PASSWORD_LIFETIME_MS);
            return proven.spendProvenPassword({ hash, password: standIn });
        });
        expect(opened).toBe(false);
    });

    it("needs a hash, and the real password still works inside the scope", async () => {
        const hasher = authModule.passwordHasher({});
        const hash = await hasher.hash("a secret nobody keeps");
        expect(() => proven.withProvenPassword("", async () => true)).toThrow(RangeError);
        expect(
            await proven.withProvenPassword(hash, () => hasher.verify({ hash, password: "a secret nobody keeps" }))
        ).toBe(true);
    });
});
