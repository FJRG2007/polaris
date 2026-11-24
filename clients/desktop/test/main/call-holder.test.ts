/**
 * Which window is in a call, as the app reads it before moving a window to
 * another address: the page that took the call's keys and has not let them go.
 * A move loads another page, and a call never survives that.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    globalShortcut: { register: () => true, unregister: () => undefined }
}));

const { holdsCall, setCallHotkeys } = await import("../../src/main/call-hotkeys");

function contents() {
    return {
        isDestroyed: () => false,
        send: () => undefined,
        once: () => undefined
    } as unknown as Parameters<typeof setCallHotkeys>[0];
}

describe("a window in a call", () => {
    it("is the one whose page took the keys, bindings or not", () => {
        const page = contents();
        expect(holdsCall(page)).toBe(false);
        setCallHotkeys(page, { mic: [], deafen: [] });
        expect(holdsCall(page)).toBe(true);
        expect(holdsCall(contents())).toBe(false);
    });

    it("stops being one when its page lets the keys go", () => {
        const page = contents();
        setCallHotkeys(page, { mic: ["F9"], deafen: [] });
        setCallHotkeys(page, null);
        expect(holdsCall(page)).toBe(false);
    });
});
