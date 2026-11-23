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
