/**
 * Every outside link ends in `openOutside`: a failed hand-over is logged and
 * retried through the shell's URL handler instead of doing nothing.
 */

import { describe, expect, it, vi } from "vitest";

const openExternal = vi.fn();
vi.mock("electron", () => ({ shell: { openExternal } }));

const { openOutside, outsideAddress } = await import("../../src/main/open-external");

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

    // BUG-0020: the address reaches the system whole and in one canonical form.
    it("hands over a long tracking link whole, trimmed and normalised", async () => {
        const long = `https://click.example.com/ls/click?upn=${"a1B2".repeat(1500)}&x=%7C`;
        const spy = deps(async () => undefined);
        await expect(openOutside(`  ${long}
`, spy)).resolves.toBe(true);
        expect(spy.open).toHaveBeenCalledWith(new URL(long).href);
        expect((spy.open.mock.calls[0] as unknown as [string])[0].length).toBe(new URL(long).href.length);
    });

    it("normalises an address with a space in it before any route sees it", async () => {
        const spy = deps(async () => {
            throw new Error("first");
        });
        await openOutside("https://example.com/a b?q=1 2", spy);
        expect(spy.open).toHaveBeenCalledWith("https://example.com/a%20b?q=1%202");
        expect(spy.fallback).toHaveBeenCalledWith("https://example.com/a%20b?q=1%202");
    });

    it("refuses every scheme but the web and mail before any route", () => {
        for (const url of ["file:///C:/x", "javascript:alert(1)", "ms-settings:x", "\\host\share", "not a url"])
            expect(outsideAddress(url)).toBeNull();
        expect(outsideAddress("mailto:a@example.com")).toBe("mailto:a@example.com");
    });
});
