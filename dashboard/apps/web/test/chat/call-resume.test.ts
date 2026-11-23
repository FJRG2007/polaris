/**
 * Coming back into a call after the update button reloads the tab.
 *
 * The note left behind is the whole feature, and every rule about it is one that
 * only shows up as somebody's microphone doing something they did not ask for.
 * Read twice and a later reload walks back into a finished call; kept too long
 * and a tab a browser restores in the morning joins last night's; not checked
 * against who is signed in and a shared machine puts one person into another's
 * room.
 *
 * So it is exercised here rather than by reloading a page with a call on it.
 */

import type { CallSession } from "@/app/(app)/chat/call-hold";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    holdCallForRestart,
    rememberCall,
    takeCallNote,
    takeRelaunchedCall,
    takeRememberedCall
} from "@/app/(app)/chat/call-resume";

const SESSION: CallSession = {
    meetingId: "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
    channelId: "019f8506-21f4-7173-a097-47c1fe63a88b",
    title: "Standup"
};

const VIEWER = "019f0000-0000-7000-8000-000000000001";

/** A tab's own storage, as far as this module uses it. */
function fakeStorage() {
    const held = new Map<string, string>();
    return {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => void held.set(key, value),
        removeItem: (key: string) => void held.delete(key),
        get size() {
            return held.size;
        }
    };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
    storage = fakeStorage();
    (globalThis as { window?: unknown }).window = { sessionStorage: storage };
});

afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
});

/** What the next page load reports it was. */
function loadedBy(type: string) {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
        { type } as unknown as PerformanceEntry
    ]);
}

describe("the note a reload carries", () => {
    it("brings back the call, and whether the camera was on", () => {
        rememberCall(SESSION, true, VIEWER);
        expect(takeRememberedCall(VIEWER)).toEqual({ session: SESSION, video: true });
    });

    it("brings back a call that had no camera as one with no camera", () => {
        rememberCall(SESSION, false, VIEWER);
        expect(takeRememberedCall(VIEWER)?.video).toBe(false);
    });

    it("is read once and only once", () => {
        rememberCall(SESSION, true, VIEWER);
        expect(takeRememberedCall(VIEWER)).not.toBeNull();
        // A reload the reader typed, minutes later, must not rejoin anything.
        expect(takeRememberedCall(VIEWER)).toBeNull();
    });

    it("is gone even when it was not used", () => {
        // Left behind, it fires on the next reload instead.
        rememberCall(SESSION, true, VIEWER);
        expect(takeRememberedCall("somebody-else")).toBeNull();
        expect(storage.size).toBe(0);
    });

    it("is not another person's call", () => {
        rememberCall(SESSION, true, VIEWER);
        expect(takeRememberedCall("019f0000-0000-7000-8000-000000000002")).toBeNull();
    });

    it("goes stale rather than joining last night's call", () => {
        rememberCall(SESSION, true, VIEWER);
        const raw = JSON.parse(storage.getItem("polaris.call.resume")!) as { at: number };
        raw.at = Date.now() - 10 * 60 * 1000;
        storage.setItem("polaris.call.resume", JSON.stringify(raw));
        expect(takeRememberedCall(VIEWER)).toBeNull();
    });

    it("says nothing when there is nothing written down", () => {
        expect(takeRememberedCall(VIEWER)).toBeNull();
    });

    it("refuses a note that is not one", () => {
        for (const bad of ["not json", "{}", '{"at":0}', '{"session":{"meetingId":1}}']) {
            storage.setItem("polaris.call.resume", bad);
            expect(takeRememberedCall(VIEWER)).toBeNull();
        }
    });
});

/**
 * The note the page writes as it is left mid-call. A reload is a refresh, so it
 * walks back in; anything else is leaving, and a microphone must not open itself.
 */
describe("the note a page leaves on its way out", () => {
    it("brings the call back after a reload", () => {
        rememberCall(SESSION, false, VIEWER, "leaving");
        loadedBy("reload");
        expect(takeRememberedCall(VIEWER)?.session).toEqual(SESSION);
    });

    it("says the call was lost when the page came back some other way", () => {
        rememberCall(SESSION, false, VIEWER, "leaving");
        loadedBy("navigate");
        expect(takeCallNote(VIEWER)).toEqual({ kind: "lost", session: SESSION });
        // Read once, like every other note.
        expect(takeCallNote(VIEWER)).toBeNull();
    });

    it("brings the call back when the page loads the same address again at once", () => {
        // What the framework does on its own after an update: it loads the page
        // afresh, which the browser reports as a navigation, not a reload.
        const at = { pathname: "/chat/general", search: "?call=1" };
        (globalThis as { window?: unknown }).window = { sessionStorage: storage, location: at };
        rememberCall(SESSION, true, VIEWER, "leaving");
        loadedBy("navigate");
        expect(takeRememberedCall(VIEWER)).toEqual({ session: SESSION, video: true });
    });

    it("says the call was lost when the same address comes back late, or another one does", () => {
        const at = { pathname: "/chat/general", search: "" };
        (globalThis as { window?: unknown }).window = { sessionStorage: storage, location: at };
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        rememberCall(SESSION, false, VIEWER, "leaving");
        clock.mockReturnValue(now + 30_000);
        loadedBy("navigate");
        expect(takeCallNote(VIEWER)).toEqual({ kind: "lost", session: SESSION });
        clock.mockReturnValue(now);
        rememberCall(SESSION, false, VIEWER, "leaving");
        at.pathname = "/home";
        expect(takeCallNote(VIEWER)).toEqual({ kind: "lost", session: SESSION });
    });

    it("does not after navigating away and back", () => {
        for (const type of ["navigate", "back_forward"]) {
            rememberCall(SESSION, false, VIEWER, "leaving");
            loadedBy(type);
            expect(takeRememberedCall(VIEWER), type).toBeNull();
        }
    });

    it("leaves the update banner's own note to count however the page loaded", () => {
        rememberCall(SESSION, false, VIEWER);
        loadedBy("navigate");
        expect(takeRememberedCall(VIEWER)?.session).toEqual(SESSION);
    });

    it("does not overwrite the update banner's note as the page is left", () => {
        rememberCall(SESSION, true, VIEWER);
        rememberCall(SESSION, false, VIEWER, "leaving");
        loadedBy("navigate");
        expect(takeRememberedCall(VIEWER)).toEqual({ session: SESSION, video: true });
    });

    it("replaces a banner note that has gone stale", () => {
        rememberCall(SESSION, true, VIEWER);
        const raw = JSON.parse(storage.getItem("polaris.call.resume")!) as { at: number };
        raw.at = Date.now() - 10 * 60 * 1000;
        storage.setItem("polaris.call.resume", JSON.stringify(raw));
        rememberCall(SESSION, false, VIEWER, "leaving");
        loadedBy("navigate");
        expect(takeRememberedCall(VIEWER)).toBeNull();
    });
});

/**
 * The desktop app as far as a call carried across its restart goes: what the
 * page handed it while on a call, and what it hands back after a restart it
 * made, which is the page's note only when it wrote one down.
 */
function desktopApp(options: { restart?: "update" | "relaunch" | null; legacy?: boolean } = {}) {
    let held: string | null = null;
    const bridge: Record<string, unknown> = {
        version: "0.1.70",
        notify: () => undefined,
        closeNotice: () => undefined,
        pickFolder: () => undefined,
        pushLocal: () => undefined,
        openWindow: () => undefined
    };
    if (!options.legacy) {
        bridge.holdCall = async (note: string | null) => {
            held = note;
            return true;
        };
        bridge.relaunched = async () => {
            if (!options.restart) return null;
            const call = held;
            held = null;
            return { reason: options.restart, at: Date.now(), call };
        };
    }
    (globalThis as { window?: unknown }).window = { sessionStorage: storage, polarisDesktop: bridge };
    return { held: () => held, bridge };
}

describe("a call carried across a restart of the desktop app", () => {
    it("walks back into the call, with the camera as it was, after an update restart", async () => {
        desktopApp({ restart: "update" });
        holdCallForRestart(SESSION, true, VIEWER);
        await Promise.resolve();
        expect(await takeRelaunchedCall(VIEWER)).toEqual({ session: SESSION, video: true });
    });

    it("never rings anybody again", async () => {
        const app = desktopApp({ restart: "relaunch" });
        holdCallForRestart({ ...SESSION, placedAt: Date.now() }, false, VIEWER);
        await Promise.resolve();
        expect(JSON.parse(app.held()!).session.placedAt).toBeUndefined();
        expect((await takeRelaunchedCall(VIEWER))?.session.placedAt).toBeUndefined();
    });

    it("carries nothing once the call ended", async () => {
        const app = desktopApp({ restart: "update" });
        holdCallForRestart(SESSION, false, VIEWER);
        holdCallForRestart(null, false, VIEWER);
        await Promise.resolve();
        expect(app.held()).toBeNull();
        expect(await takeRelaunchedCall(VIEWER)).toBeNull();
    });

    it("does not rejoin when the app was quit and opened again", async () => {
        desktopApp({ restart: null });
        holdCallForRestart(SESSION, true, VIEWER);
        await Promise.resolve();
        expect(await takeRelaunchedCall(VIEWER)).toBeNull();
    });

    it("is somebody else's call after signing in as another person", async () => {
        desktopApp({ restart: "update" });
        holdCallForRestart(SESSION, true, VIEWER);
        await Promise.resolve();
        expect(await takeRelaunchedCall("019f0000-0000-7000-8000-000000000002")).toBeNull();
    });

    it("is nothing past the window, or for an answer that is not one", async () => {
        const app = desktopApp({ restart: "update" });
        app.bridge.relaunched = async () => ({
            reason: "update",
            at: Date.now() - 10 * 60 * 1000,
            call: JSON.stringify({ session: SESSION, video: true, viewerId: VIEWER, at: Date.now() })
        });
        expect(await takeRelaunchedCall(VIEWER)).toBeNull();
        app.bridge.relaunched = async () => ({ reason: "crash", at: Date.now(), call: "{}" });
        expect(await takeRelaunchedCall(VIEWER)).toBeNull();
        app.bridge.relaunched = async () => {
            throw new Error("closed");
        };
        expect(await takeRelaunchedCall(VIEWER)).toBeNull();
    });

    it("works with an app from before it, and in a plain browser tab", async () => {
        desktopApp({ legacy: true });
        holdCallForRestart(SESSION, true, VIEWER);
        expect(await takeRelaunchedCall(VIEWER)).toBeNull();
        (globalThis as { window?: unknown }).window = { sessionStorage: storage };
        holdCallForRestart(SESSION, true, VIEWER);
        expect(await takeRelaunchedCall(VIEWER)).toBeNull();
        expect(storage.size).toBe(0);
    });

    it("leaves a reload of the same tab to the tab's own note", async () => {
        desktopApp({ restart: null });
        rememberCall(SESSION, true, VIEWER);
        expect(takeRememberedCall(VIEWER)).toEqual({ session: SESSION, video: true });
    });
});
