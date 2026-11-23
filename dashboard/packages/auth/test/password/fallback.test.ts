/**
 * The password check every better-auth route and every Polaris helper makes
 * (`ctx.password.verify`): better-auth's own hasher first, the app's
 * `passwordFallback` only on a mismatch. An account whose password was set over
 * OPAQUE has a hash that opens for nothing, and the fallback is what keeps its
 * second factor, lock screen and PIN reachable (docs/chat-e2ee-phase1.md).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:1/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = "https://polaris.example.com";
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

describe("the password check", () => {
    it("a matching hash answers yes without asking the fallback", async () => {
        const fallback = vi.fn(async () => false);
        const ctx = await authModule.createAuth({ passwordFallback: fallback }).$context;
        const hash = await ctx.password.hash("right password here");
        expect(await ctx.password.verify({ hash, password: "right password here" })).toBe(true);
        expect(fallback).not.toHaveBeenCalled();
    });

    it("a mismatch asks the fallback, with the hash it was compared to", async () => {
        const fallback = vi.fn(async ({ password }: { hash: string; password: string }) => password === "set over opaque");
        const ctx = await authModule.createAuth({ passwordFallback: fallback }).$context;
        const hash = await ctx.password.hash("a secret nobody keeps");
        expect(await ctx.password.verify({ hash, password: "set over opaque" })).toBe(true);
        expect(fallback).toHaveBeenCalledWith({ hash, password: "set over opaque" });
        expect(await ctx.password.verify({ hash, password: "wrong" })).toBe(false);
    });

    it("a fallback that fails is a no, and without one a mismatch is a mismatch", async () => {
        const failing = await authModule.createAuth({
            passwordFallback: async () => {
                throw new Error("database down");
            }
        }).$context;
        const hash = await failing.password.hash("a secret nobody keeps");
        expect(await failing.password.verify({ hash, password: "anything" })).toBe(false);
        const plain = await authModule.createAuth().$context;
        expect(await plain.password.verify({ hash, password: "anything" })).toBe(false);
    });
});

describe("the time a password check takes", () => {
    const FLOOR = 300;
    const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
        const began = performance.now();
        const result = await run();
        return [result, performance.now() - began];
    };

    it("is the same for a wrong password whether or not the fallback had a record to try", async () => {
        // One account the fallback finds nothing for, one it runs an expensive check on.
        const fallback = async ({ password }: { hash: string; password: string }) => {
            if (password.startsWith("hashless")) await new Promise((resolve) => setTimeout(resolve, 120));
            return false;
        };
        const ctx = await authModule.createAuth({ passwordFallback: fallback, passwordCheckFloorMs: () => FLOOR }).$context;
        const hash = await ctx.password.hash("a secret nobody keeps");
        const [plainResult, plain] = await timed(() => ctx.password.verify({ hash, password: "plain wrong" }));
        const [hashlessResult, hashless] = await timed(() => ctx.password.verify({ hash, password: "hashless wrong" }));
        expect(plainResult).toBe(false);
        expect(hashlessResult).toBe(false);
        expect(plain).toBeGreaterThanOrEqual(FLOOR - 5);
        expect(hashless).toBeGreaterThanOrEqual(FLOOR - 5);
        expect(Math.abs(plain - hashless)).toBeLessThan(60);
    });

    it("is the same for an address with no account, which better-auth answers with a hash", async () => {
        const ctx = await authModule.createAuth({ passwordFallback: async () => false, passwordCheckFloorMs: () => FLOOR })
            .$context;
        const hash = await ctx.password.hash("a secret nobody keeps");
        const [, unknown] = await timed(() => ctx.password.hash("guessed password"));
        const [, wrong] = await timed(() => ctx.password.verify({ hash, password: "guessed password" }));
        expect(unknown).toBeGreaterThanOrEqual(FLOOR - 5);
        expect(Math.abs(unknown - wrong)).toBeLessThan(60);
    });

    it("is never padded for the right password, nor for a PIN or an answer", async () => {
        const auth = authModule.createAuth({ passwordFallback: async () => false, passwordCheckFloorMs: () => 2_000 });
        const ctx = await auth.$context;
        const hash = await authModule.passwordHasher({}).hash("right password here");
        const [opens, right] = await timed(() => ctx.password.verify({ hash, password: "right password here" }));
        expect(opens).toBe(true);
        expect(right).toBeLessThan(1_000);
        const security = await import("../../src/security.js");
        const [pinHash, hashing] = await timed(() => security.hashSecret(auth, "1234"));
        const [pinWrong, checking] = await timed(() => security.verifySecret(auth, pinHash, "4321"));
        expect(pinWrong).toBe(false);
        expect(hashing + checking).toBeLessThan(1_000);
    });
});
