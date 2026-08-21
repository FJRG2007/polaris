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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberCall, takeRememberedCall } from "@/app/(app)/chat/call-resume";

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
});

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
