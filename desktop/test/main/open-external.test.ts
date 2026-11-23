/**
 * Every outside link ends in `openOutside`: each route is tried in order, a
 * failed one is logged, and the next is tried instead of doing nothing.
 */

import { describe, expect, it, vi } from "vitest";

const openExternal = vi.fn();
vi.mock("electron", () => ({ shell: { openExternal }, clipboard: { writeText: vi.fn() } }));

const { openOutside, outsideAddress, routesFor } = await import("../../src/main/open-external");

const deps = (open: () => Promise<void>, fallback: (() => Promise<void>) | null = vi.fn(async () => undefined)) => {
    const first = vi.fn(open);
    const second = fallback ? vi.fn(fallback) : null;
    return {
        open: first,
        fallback: second,
        routes: [{ name: "first", run: first }, ...(second ? [{ name: "second", run: second }] : [])],
        log: vi.fn()
    };
};

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

describe("routesFor", () => {
    const BRAVE = String.raw`C:\B\brave.exe`;
    const system = () => ({
        open: vi.fn(async (_url: string) => undefined),
        readRegistry: vi.fn(async (key: string, _value: string | null): Promise<string | null> =>
            key.endsWith("UserChoice") ? "BraveHTML" : key.startsWith("HKCR\\BraveHTML") ? `"${BRAVE}" --single-argument %1` : null
        ),
        launch: vi.fn(async (_file: string, _args: readonly string[]) => undefined),
        opener: vi.fn(async (_file: string, _url: string) => undefined)
    });

    // BUG-0020: Windows' hand-over resolved with no browser; the registered
    // command is started directly first, and its start can be seen to fail.
    it("starts the default browser's command first on Windows, as an argument array", async () => {
        const fake = system();
        const log = vi.fn();
        await expect(openOutside("https://example.com/a", { routes: routesFor("win32", fake), log })).resolves.toBe(true);
        expect(fake.launch).toHaveBeenCalledWith(BRAVE, ["--single-argument", "https://example.com/a"]);
        expect(fake.open).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it("falls back to the system hand-over on Windows when the browser cannot be started", async () => {
        const fake = system();
        fake.launch.mockRejectedValueOnce(new Error("spawn ENOENT"));
        const log = vi.fn();
        await expect(openOutside("https://example.com/a", { routes: routesFor("win32", fake), log })).resolves.toBe(true);
        expect(fake.open).toHaveBeenCalledWith("https://example.com/a");
        expect(log).toHaveBeenCalledTimes(1);
    });

    it("falls back when no command is registered (a Store browser)", async () => {
        const fake = system();
        fake.readRegistry.mockResolvedValue(null);
        await expect(openOutside("https://example.com/", { routes: routesFor("win32", fake), log: vi.fn() })).resolves.toBe(true);
        expect(fake.launch).not.toHaveBeenCalled();
        expect(fake.open).toHaveBeenCalledTimes(1);
    });

    it("reports false when both Windows routes fail, so the dialog is shown", async () => {
        const fake = system();
        fake.launch.mockRejectedValue(new Error("a"));
        fake.open.mockRejectedValue(new Error("b"));
        await expect(openOutside("https://example.com/", { routes: routesFor("win32", fake), log: vi.fn() })).resolves.toBe(false);
    });

    it("never uses rundll32 or a shell", () => {
        expect(routesFor("win32", system()).map((route) => route.name).join(" ")).not.toMatch(/rundll32|cmd/);
    });

    it("tries the system first and then open on macOS, xdg-open on Linux", async () => {
        for (const [platform, opener] of [["darwin", "open"], ["linux", "xdg-open"]] as const) {
            const fake = system();
            fake.open.mockRejectedValue(new Error("no handler"));
            await expect(openOutside("https://example.com/", { routes: routesFor(platform, fake), log: vi.fn() })).resolves.toBe(true);
            expect(fake.opener).toHaveBeenCalledWith(opener, "https://example.com/");
            expect(fake.launch).not.toHaveBeenCalled();
        }
    });
});
