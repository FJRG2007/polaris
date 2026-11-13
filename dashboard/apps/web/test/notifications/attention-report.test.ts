// @vitest-environment jsdom

/**
 * The desktop app says whether anybody is at its computer, on the connection it
 * holds, so an app left open on an empty desk stops keeping a browser in use
 * elsewhere quiet. A browser says how long ago Polaris was last touched in it.
 * Each reports only for its own connection, and an app or a server too old to
 * take part sends nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    awayFrom,
    noteStreamConnection,
    reportAttention,
    reportBrowserAttention,
    reportDesktopAttention,
    resetStreamConnection
} from "@/lib/notifications/attention-report";

const CONNECTION = "0f0e4c8a-5d3b-4f6e-9a1b-2c3d4e5f6a7b";
const OTHER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function desktop(systemIdle?: () => Promise<string>): void {
    const call = vi.fn(async () => true);
    (window as { polarisDesktop?: unknown }).polarisDesktop = {
        version: "1.0.0",
        platform: "win32",
        notify: call,
        closeNotice: call,
        pickFolder: call,
        pushLocal: call,
        openWindow: call,
        ...(systemIdle ? { systemIdle } : {})
    };
}

function sent(fetcher: ReturnType<typeof vi.fn>): unknown[] {
    return fetcher.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.useFakeTimers();
    resetStreamConnection();
    fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

describe("what counts as nobody there", () => {
    it("is idle or locked, never a system that cannot say", () => {
        expect(awayFrom("idle")).toBe(true);
        expect(awayFrom("locked")).toBe(true);
        expect(awayFrom("active")).toBe(false);
        expect(awayFrom("unknown")).toBe(false);
    });
});

describe("reporting from the desktop app", () => {
    it("says the computer is untouched on the connection it holds, then that somebody is back", async () => {
        let state = "idle";
        desktop(async () => state);
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), true);
        const stop = reportDesktopAttention();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent(fetcher)).toEqual([{ connection: CONNECTION, away: true }]);

        // Unchanged: nothing more until the repeat.
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetcher).toHaveBeenCalledTimes(1);

        state = "active";
        await vi.advanceTimersByTimeAsync(5000);
        expect(sent(fetcher).at(-1)).toEqual({ connection: CONNECTION, away: false });
        stop();
    });

    it("reports again for a new connection", async () => {
        desktop(async () => "active");
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), true);
        const stop = reportDesktopAttention();
        await vi.advanceTimersByTimeAsync(0);
        noteStreamConnection(JSON.stringify({ connection: OTHER }), true);
        await vi.advanceTimersByTimeAsync(5000);
        expect(sent(fetcher)).toEqual([
            { connection: CONNECTION, away: false },
            { connection: OTHER, away: false }
        ]);
        stop();
    });

    it("ignores a frame another window relayed", async () => {
        desktop(async () => "idle");
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), false);
        const stop = reportDesktopAttention();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetcher).not.toHaveBeenCalled();
        stop();
    });

    it("sends nothing from a server that names no connection", async () => {
        desktop(async () => "idle");
        noteStreamConnection(JSON.stringify({ items: [] }), true);
        const stop = reportDesktopAttention();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetcher).not.toHaveBeenCalled();
        stop();
    });

    it("sends nothing from an app too old to ask the system", async () => {
        desktop();
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), true);
        const stop = reportDesktopAttention();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetcher).not.toHaveBeenCalled();
        stop();
    });

    it("sends nothing from a browser", async () => {
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), true);
        const stop = reportDesktopAttention();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetcher).not.toHaveBeenCalled();
        stop();
    });
});

describe("reporting from a browser", () => {
    let kept: Map<string, string>;

    beforeEach(() => {
        kept = new Map();
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            writable: true,
            value: {
                getItem: (key: string) => kept.get(key) ?? null,
                setItem: (key: string, value: string) => void kept.set(key, String(value)),
                removeItem: (key: string) => void kept.delete(key)
            }
        });
        vi.spyOn(document, "hasFocus").mockReturnValue(true);
    });

    afterEach(() => vi.restoreAllMocks());

    it("says how long ago Polaris was last touched, on its own connection", async () => {
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), true);
        const stop = reportBrowserAttention();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent(fetcher)).toEqual([{ connection: CONNECTION, idleMs: 0 }]);
        await vi.advanceTimersByTimeAsync(60_000);
        const last = sent(fetcher).at(-1) as { idleMs: number };
        expect(last.idleMs).toBeGreaterThanOrEqual(30_000);
        stop();
    });

    it("counts a touch in another tab of the browser", async () => {
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), true);
        const stop = reportBrowserAttention();
        await vi.advanceTimersByTimeAsync(90_000);
        kept.set("polaris.attention.touched", String(Date.now()));
        await vi.advanceTimersByTimeAsync(5_000);
        const last = sent(fetcher).at(-1) as { idleMs: number };
        expect(last.idleMs).toBeLessThanOrEqual(5_000);
        stop();
    });

    it("notes its own touches for the tab that holds the connection", async () => {
        const stop = reportBrowserAttention();
        await vi.advanceTimersByTimeAsync(10_000);
        window.dispatchEvent(new Event("keydown"));
        expect(Number(kept.get("polaris.attention.touched"))).toBe(Date.now());
        // No connection here: it relays, it does not report.
        expect(fetcher).not.toHaveBeenCalled();
        stop();
    });

    it("says nothing for a browser never touched since it opened", async () => {
        vi.spyOn(document, "hasFocus").mockReturnValue(false);
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), true);
        const stop = reportBrowserAttention();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetcher).not.toHaveBeenCalled();
        stop();
    });

    it("leaves the desktop app to its own report", async () => {
        desktop(async () => "active");
        noteStreamConnection(JSON.stringify({ connection: CONNECTION }), true);
        const stop = reportAttention();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent(fetcher)).toEqual([{ connection: CONNECTION, away: false }]);
        stop();
    });
});
