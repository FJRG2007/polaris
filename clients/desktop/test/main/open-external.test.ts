/**
 * Every outside link ends in `openOutside`: each route is tried in order, a
 * failed one is logged, and the next is tried instead of doing nothing.
 */

import { describe, expect, it, vi } from "vitest";

const openExternal = vi.fn();
vi.mock("electron", () => ({ shell: { openExternal }, clipboard: { writeText: vi.fn() }, BrowserWindow: {}, app: {} }));

const { RouteUnavailable, linkNotice, openOutside, openOutsideOutcome, outsideAddress, routesFor } = await import("../../src/main/open-external");
const { BrowserRefused, ShellUnavailable } = await import("../../src/main/default-browser");

/** What `launchDetached` rejects with when the started browser turned the link down. */
const refusedWith = (code: number) => new BrowserRefused(`brave.exe exited with code ${code}: the browser exited without taking the link`, code);

/** The log lines that record a failure; a working route logs with a null error. */
const failures = (log: ReturnType<typeof vi.fn>) => log.mock.calls.filter(([, error]) => error !== null);

const deps = (open: () => Promise<void>, fallback: (() => Promise<void>) | null = vi.fn(async () => undefined)) => {
    const first = vi.fn(open);
    const second = fallback ? vi.fn(fallback) : null;
    return {
        open: first,
        fallback: second,
        routes: [{ name: "first", run: first, confirms: true }, ...(second ? [{ name: "second", run: second, confirms: true }] : [])],
        log: vi.fn()
    };
};

describe("openOutside", () => {
    it("hands a web address to the system and stops there", async () => {
        const spy = deps(async () => undefined);
        await expect(openOutside("https://cursor.com/login?a=1&b=2", spy)).resolves.toBe(true);
        expect(spy.open).toHaveBeenCalledWith("https://cursor.com/login?a=1&b=2");
        expect(spy.fallback).not.toHaveBeenCalled();
        expect(failures(spy.log)).toHaveLength(0);
    });

    it("logs a rejection and retries through the fallback", async () => {
        const spy = deps(async () => {
            throw new Error("Failed to open: Application not found");
        });
        await expect(openOutside("https://opencode.ai/auth", spy)).resolves.toBe(true);
        expect(failures(spy.log)).toHaveLength(1);
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
        shell: vi.fn(async (_url: string) => undefined),
        opener: vi.fn(async (_file: string, _url: string) => undefined)
    });

    // BUG-0020: Windows' hand-over resolved with no browser; the registered
    // command is started directly first, and its start can be seen to fail.
    it("starts the default browser's command first on Windows, as an argument array", async () => {
        const fake = system();
        const log = vi.fn();
        await expect(openOutside("https://example.com/a", { routes: routesFor("win32", fake), log })).resolves.toBe(true);
        expect(fake.launch).toHaveBeenCalledWith(BRAVE, ["--single-argument", "https://example.com/a"]);
        expect(fake.shell).not.toHaveBeenCalled();
        expect(fake.open).not.toHaveBeenCalled();
        expect(failures(log)).toHaveLength(0);
    });

    // BUG-0071: the browser could not be started (spawn EPERM), Explorer could
    // not start it either and showed the system's error box titled with the
    // address. A start that never happened skips Explorer for the no-UI route.
    it("skips Explorer when the browser could not be started, and asks shell.openExternal", async () => {
        for (const message of ["spawn EPERM", "spawn EACCES", "spawn ENOENT", String.raw`C:\B\brave.exe is not there`]) {
            const fake = system();
            fake.launch.mockRejectedValueOnce(new Error(message));
            const log = vi.fn();
            await expect(openOutsideOutcome("https://example.com/a", { routes: routesFor("win32", fake), log })).resolves.toBe("unconfirmed");
            expect(fake.shell).not.toHaveBeenCalled();
            expect(fake.open).toHaveBeenCalledWith("https://example.com/a");
            expect(failures(log)).toHaveLength(1);
            expect(log.mock.calls.some(([line]) => String(line).startsWith("Skipped the Windows shell (Explorer)"))).toBe(true);
        }
    });

    it("says the link failed in the window, never through Explorer, when the browser cannot be started and Windows refuses it", async () => {
        const fake = system();
        fake.launch.mockRejectedValue(new Error("spawn EPERM"));
        fake.open.mockRejectedValue(new Error("Failed to open: Access is denied."));
        await expect(openOutsideOutcome("https://example.com/", { routes: routesFor("win32", fake), log: vi.fn() })).resolves.toBe("failed");
        expect(fake.shell).not.toHaveBeenCalled();
    });

    // BUG-0020: Brave started by Polaris exited 1 with Brave already open, and
    // the page never arrived; Explorer starts it the way any other click does.
    it("hands a refused link to Explorer, and shows nothing for a route that raised no refusal", async () => {
        const fake = system();
        fake.launch.mockRejectedValueOnce(refusedWith(1));
        const log = vi.fn();
        await expect(openOutsideOutcome("https://example.com/a", { routes: routesFor("win32", fake), log })).resolves.toBe("unconfirmed");
        expect(fake.shell).toHaveBeenCalledWith("https://example.com/a");
        expect(fake.open).not.toHaveBeenCalled();
        expect(String(failures(log)[0]?.[1])).toContain("code 1");
        expect(log.mock.calls.at(-1)?.[0]).toBe("Opened https://example.com through the Windows shell (Explorer) (not confirmed)");
    });

    it("asks Windows through shell.openExternal when Explorer cannot take the address", async () => {
        const fake = system();
        fake.launch.mockRejectedValueOnce(refusedWith(1));
        fake.shell.mockRejectedValueOnce(new ShellUnavailable("Explorer would split this address at its comma"));
        await expect(openOutsideOutcome("https://example.com/a,b", { routes: routesFor("win32", fake), log: vi.fn() })).resolves.toBe("unconfirmed");
        expect(fake.open).toHaveBeenCalledWith("https://example.com/a,b");
    });

    it("is failed only when every Windows route refused the link", async () => {
        const fake = system();
        fake.launch.mockRejectedValue(refusedWith(21));
        fake.shell.mockRejectedValue(new Error("spawn EACCES"));
        fake.open.mockRejectedValue(new Error("Failed to open: Application not found"));
        await expect(openOutsideOutcome("https://example.com/", { routes: routesFor("win32", fake), log: vi.fn() })).resolves.toBe("failed");
    });

    it("is opened when a browser took the link, or when no earlier route refused it", async () => {
        await expect(openOutsideOutcome("https://example.com/a", { routes: routesFor("win32", system()), log: vi.fn() })).resolves.toBe("opened");
        const store = system();
        store.readRegistry.mockResolvedValue(null);
        await expect(openOutsideOutcome("https://example.com/a", { routes: routesFor("win32", store), log: vi.fn() })).resolves.toBe("opened");
        expect(store.shell).not.toHaveBeenCalled();
        expect(store.open).toHaveBeenCalledTimes(1);
    });

    it("logs every attempt by host only, never the whole address", async () => {
        const fake = system();
        fake.launch.mockRejectedValueOnce(refusedWith(21));
        const log = vi.fn();
        await openOutsideOutcome("https://example.com/reset?token=secret-value", { routes: routesFor("win32", fake), log });
        expect(log).toHaveBeenCalledTimes(2);
        for (const [message] of log.mock.calls) {
            expect(message).toContain("https://example.com");
            expect(message).not.toContain("secret-value");
        }
        expect(new RouteUnavailable("x")).toBeInstanceOf(Error);
    });

    it("asks shell.openExternal, not Explorer, when no command is registered (a Store browser)", async () => {
        const fake = system();
        fake.readRegistry.mockResolvedValue(null);
        await expect(openOutside("https://example.com/", { routes: routesFor("win32", fake), log: vi.fn() })).resolves.toBe(true);
        expect(fake.launch).not.toHaveBeenCalled();
        expect(fake.shell).not.toHaveBeenCalled();
        expect(fake.open).toHaveBeenCalledTimes(1);
    });

    it("tries the Windows routes in order: the browser, Explorer only after a refusal, then shell.openExternal", async () => {
        expect(routesFor("win32", system()).map((route) => route.name)).toEqual([
            "the default browser's registered command",
            "the Windows shell (Explorer)",
            "the system's URL handler"
        ]);
        const fake = system();
        const order: string[] = [];
        fake.launch.mockImplementation(async () => {
            order.push("launch");
            throw refusedWith(1);
        });
        fake.shell.mockImplementation(async () => {
            order.push("shell");
            throw new ShellUnavailable("comma");
        });
        fake.open.mockImplementation(async () => {
            order.push("open");
        });
        await openOutsideOutcome("https://example.com/", { routes: routesFor("win32", fake), log: vi.fn() });
        expect(order).toEqual(["launch", "shell", "open"]);
    });

    it("reports false when every Windows route fails, so the person is told", async () => {
        const fake = system();
        fake.launch.mockRejectedValue(refusedWith(1));
        fake.shell.mockRejectedValue(new Error("c"));
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
            expect(fake.shell).not.toHaveBeenCalled();
        }
    });
});

describe("linkNotice", () => {
    it("names the browser or the mail app and carries the whole address", () => {
        const long = `https://example.com/t?${"x".repeat(3000)}`;
        expect(linkNotice(long)).toEqual({ url: long, title: "Couldn't open the link", body: "Your browser didn't open it. Copy it and paste it there." });
        expect(linkNotice("mailto:a@example.com").body).toBe("Your mail app didn't open it. Copy it and paste it there.");
    });
});

// BUG-0020: a link is never answered with the system's alert box.
// BUG-0071: Explorer, the one route that can show one, runs only after a
// browser that started and turned the link down.
describe("no system alert for a link", () => {
    it("reaches Explorer only after a browser refusal", () => {
        const [, desktop] = routesFor("win32");
        expect(desktop?.after?.(refusedWith(1))).toBe(true);
        for (const other of [null, new Error("spawn EPERM"), new RouteUnavailable("none"), new ShellUnavailable("x"), "text"]) expect(desktop?.after?.(other)).toBe(false);
    });

    it("open-external.ts has no dialog", async () => {
        const { readFileSync } = await import("node:fs");
        const source = readFileSync(new URL("../../src/main/open-external.ts", import.meta.url), "utf8");
        expect(source).not.toMatch(/dialog|showMessageBox/);
    });
});
