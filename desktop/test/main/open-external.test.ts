/**
 * Every outside link ends in `openOutside`: a failed hand-over is logged and
 * retried through the shell's URL handler instead of doing nothing.
 */

import { describe, expect, it, vi } from "vitest";

const openExternal = vi.fn();
vi.mock("electron", () => ({ shell: { openExternal } }));

const { openOutside } = await import("../../src/main/open-external");

const deps = (open: () => Promise<void>, fallback: (() => Promise<void>) | null = vi.fn(async () => undefined)) => ({
    open: vi.fn(open),
    fallback: fallback ? vi.fn(fallback) : null,
    log: vi.fn()
});

describe("openOutside", () => {
    it("hands a web address to the system and stops there", async () => {
        const spy = deps(async () => undefined);
        await expect(openOutside("https://cursor.com/login?a=1&b=2", spy)).resolves.toBe(true);
        expect(spy.open).toHaveBeenCalledWith("https://cursor.com/login?a=1&b=2");
        expect(spy.fallback).not.toHaveBeenCalled();
        expect(spy.log).not.toHaveBeenCalled();
    });

    it("logs a rejection and retries through the fallback", async () => {
        const spy = deps(async () => {
            throw new Error("Failed to open: Application not found");
        });
        await expect(openOutside("https://opencode.ai/auth", spy)).resolves.toBe(true);
        expect(spy.log).toHaveBeenCalledTimes(1);
        expect(spy.fallback).toHaveBeenCalledWith("https://opencode.ai/auth");
    });

    it("reports false and logs both when every route fails", async () => {
        const spy = deps(
            async () => {
                throw new Error("first");
            },
            async () => {
                throw new Error("second");
            }
        );
        await expect(openOutside("mailto:a@example.com", spy)).resolves.toBe(false);
        expect(spy.log).toHaveBeenCalledTimes(2);
    });

    it("has nothing to retry with where there is no fallback", async () => {
        const spy = deps(async () => {
            throw new Error("first");
        }, null);
        await expect(openOutside("https://example.com/", spy)).resolves.toBe(false);
        expect(spy.log).toHaveBeenCalledTimes(1);
    });

    it("never hands over anything but http, https and mailto", async () => {
        for (const url of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "\\host\share", "ms-settings:", "not a url"]) {
            const spy = deps(async () => undefined);
            await expect(openOutside(url, spy)).resolves.toBe(false);
            expect(spy.open).not.toHaveBeenCalled();
            expect(spy.fallback).not.toHaveBeenCalled();
        }
    });
});
