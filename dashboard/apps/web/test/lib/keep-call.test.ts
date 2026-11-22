/**
 * Moving around Polaris without hanging up.
 *
 * Every way a click or a screen used to take the call with it is a case here:
 * a full load to another address, a client navigation to a screen with no shell,
 * a plain link nobody routed, and the full loads that really are needed, which
 * must walk back into the call - and an intentional hang-up, which must not.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { CallSession } from "@/app/(app)/chat/call-hold";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberCall, takeCallNote } from "@/app/(app)/chat/call-resume";
import {
    OUTSIDE_APP_PREFIXES,
    bindRouter,
    carryCallThroughNextLoad,
    isOutsideApp,
    leavePage,
    linkVerdict,
    loadPage,
    navigateInApp,
    setCallLive
} from "@/lib/keep-call";

const APP_DIR = fileURLToPath(new URL("../../src/app", import.meta.url));

const SESSION: CallSession = {
    meetingId: "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
    channelId: "019f8506-21f4-7173-a097-47c1fe63a88b",
    title: "Standup"
};
const VIEWER = "019f0000-0000-7000-8000-000000000001";
const BASE = "https://polaris.example.test/chat/c/general";

function fakeStorage() {
    const held = new Map<string, string>();
    return {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => void held.set(key, value),
        removeItem: (key: string) => void held.delete(key)
    };
}

let assign: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;
let location: { href: string; pathname: string; search: string; assign: typeof assign };

beforeEach(() => {
    assign = vi.fn();
    open = vi.fn();
    location = { href: BASE, pathname: "/chat/c/general", search: "", assign };
    (globalThis as { window?: unknown }).window = { sessionStorage: fakeStorage(), location, open };
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
        { type: "navigate" } as unknown as PerformanceEntry
    ]);
});

afterEach(() => {
    setCallLive(false);
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
});

/** Where the next page landed, after the one that wrote the note went away. */
function landOn(pathname: string): void {
    location.pathname = pathname;
    location.href = `https://polaris.example.test${pathname}`;
}

describe("which screens have no shell", () => {
    it("knows a screen outside the shell from one under it", () => {
        expect(isOutsideApp("/m/abc")).toBe(true);
        expect(isOutsideApp("/office/show/1")).toBe(true);
        expect(isOutsideApp("/mail/print/9")).toBe(true);
        expect(isOutsideApp("/oauth/login")).toBe(true);
        expect(isOutsideApp("/mail")).toBe(false);
        expect(isOutsideApp("/mail-server")).toBe(false);
        expect(isOutsideApp("/chat/c/x")).toBe(false);
        expect(isOutsideApp("/settings")).toBe(false);
        // Intercepted by the shell, so drawn inside it.
        expect(isOutsideApp("/u/someone")).toBe(false);
        expect(isOutsideApp("/o/an-org")).toBe(false);
    });

    /**
     * Kept in step with the route tree: a screen added outside the shell and not
     * listed is a click that hangs up the call, and nobody would see why.
     */
    it("lists every route outside the shell", () => {
        const missing: string[] = [];
        const isDir = (path: string) => statSync(path).isDirectory();
        const pages = (dir: string, prefix: string): string[] => {
            const found: string[] = [];
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (!isDir(path)) {
                    if (name === "page.tsx") found.push(prefix || "/");
                    continue;
                }
                if (name.startsWith("[") || name.startsWith("(")) {
                    if (pages(path, prefix).length) found.push(prefix || "/");
                    continue;
                }
                found.push(...pages(path, `${prefix}/${name}`));
            }
            return found;
        };
        for (const name of readdirSync(APP_DIR)) {
            const path = join(APP_DIR, name);
            if (!isDir(path) || name === "(app)" || name === "api") continue;
            const routes = name.startsWith("(") ? pages(path, "") : pages(path, `/${name}`).length ? [`/${name}`] : [];
            for (const route of routes) if (!isOutsideApp(route)) missing.push(route);
        }
        // The root page only redirects into the shell, and a profile opened from
        // inside it is intercepted by the shell (`(app)/(.)o`, `(app)/(.)u`).
        const intercepted = readdirSync(join(APP_DIR, "(app)"))
            .filter((name) => name.startsWith("(.)"))
            .map((name) => `/${name.slice(3)}`);
        expect(intercepted).toEqual(expect.arrayContaining(["/o", "/u"]));
        expect(missing.filter((route) => route !== "/" && !intercepted.includes(route))).toEqual([]);
        // And nothing listed is under the shell.
        for (const prefix of OUTSIDE_APP_PREFIXES)
            expect(
                readdirSync(join(APP_DIR, "(app)")).includes(prefix.slice(1)),
                `${prefix} is a screen under the shell`
            ).toBe(false);
    });
});

describe("a click on a link while a call is on", () => {
    const click = (href: string | null, extra: Partial<Parameters<typeof linkVerdict>[0]> = {}) =>
        linkVerdict({ href, base: BASE, target: null, download: false, button: 0, modified: false, routed: false, ...extra });

    it("opens a screen with no shell in a new tab, even one next/link would route", () => {
        expect(click("/m/abc")).toBe("new-tab");
        expect(click("/office/show/1", { routed: true })).toBe("new-tab");
    });

    it("routes a plain in-app link nobody took", () => {
        expect(click("/drive")).toBe("route");
        expect(click("https://polaris.example.test/tasks?x=1")).toBe("route");
    });

    it("leaves alone what is not a navigation of this page", () => {
        expect(click("/drive", { routed: true })).toBe("leave-alone");
        expect(click("https://elsewhere.example.test/")).toBe("leave-alone");
        expect(click("mailto:someone@example.test")).toBe("leave-alone");
        expect(click("/api/drive/file/1")).toBe("leave-alone");
        expect(click("/drive", { target: "_blank" })).toBe("leave-alone");
        expect(click("/drive", { download: true })).toBe("leave-alone");
        expect(click("/drive", { modified: true })).toBe("leave-alone");
        expect(click("/drive", { button: 1 })).toBe("leave-alone");
        expect(click("#reply")).toBe("leave-alone");
        expect(click(null)).toBe("leave-alone");
    });
});

describe("moving the page from outside React", () => {
    it("routes an in-app address once the shell has handed over its router", () => {
        const push = vi.fn();
        const unbind = bindRouter(push);
        navigateInApp("/tasks?view=board");
        expect(push).toHaveBeenCalledWith("/tasks?view=board");
        expect(assign).not.toHaveBeenCalled();
        unbind();
        navigateInApp("/tasks");
        expect(assign).toHaveBeenCalledWith("/tasks");
    });

    it("opens a screen with no shell in a new tab only while a call is on", () => {
        const unbind = bindRouter(vi.fn());
        navigateInApp("/status/x");
        expect(assign).toHaveBeenCalledWith("/status/x");
        setCallLive(true);
        navigateInApp("/status/x");
        leavePage("/oauth/login?add=1");
        expect(open).toHaveBeenCalledWith("/status/x", "_blank", "noopener");
        expect(open).toHaveBeenCalledWith("/oauth/login?add=1", "_blank", "noopener");
        unbind();
    });
});

describe("a full load the page needs", () => {
    it("walks back into the call wherever it lands", () => {
        setCallLive(true);
        loadPage("/vpn");
        expect(assign).toHaveBeenCalledWith("/vpn");
        // The page goes away mid-call, then the next one loads somewhere else.
        rememberCall(SESSION, true, VIEWER, "leaving");
        landOn("/vpn");
        expect(takeCallNote(VIEWER)).toEqual({ kind: "resume", session: SESSION, video: true });
    });

    it("says nothing to carry when no call is on", () => {
        loadPage("/vpn");
        rememberCall(SESSION, false, VIEWER, "leaving");
        landOn("/vpn");
        expect(takeCallNote(VIEWER)).toEqual({ kind: "lost", session: SESSION });
    });

    it("never walks back into a call that was hung up before the load", () => {
        setCallLive(true);
        loadPage("/vpn");
        // Hung up: the provider has no session, so nothing is written on the way out.
        landOn("/vpn");
        expect(takeCallNote(VIEWER)).toBeNull();
    });

    it("does not carry a later, unrelated departure", () => {
        vi.useFakeTimers();
        try {
            carryCallThroughNextLoad();
            vi.advanceTimersByTime(60_000);
            rememberCall(SESSION, false, VIEWER, "leaving");
            landOn("/drive");
            expect(takeCallNote(VIEWER)).toEqual({ kind: "lost", session: SESSION });
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * An error on a screen must not take the call with it. `error.tsx` never wraps
 * the layout of its own segment, so the boundary beside the `(app)` layout sits
 * inside the shell that holds the call.
 */
describe("where a screen's error is caught", () => {
    it("is inside the shell that holds the call", () => {
        const group = join(APP_DIR, "(app)");
        expect(readdirSync(group)).toContain("error.tsx");
        expect(readFileSync(join(group, "layout.tsx"), "utf8")).toMatch(/<AppChrome\b/);
        const chrome = readFileSync(join(APP_DIR, "..", "components", "app-chrome.tsx"), "utf8");
        expect(chrome).toMatch(/<CallHolder\b/);
    });
});
