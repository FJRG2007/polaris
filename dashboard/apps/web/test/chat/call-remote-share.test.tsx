// @vitest-environment jsdom

/**
 * A deck's share key, in the tab on the call.
 *
 * A browser opens its screen picker only from a press on the page, so the key
 * cannot start a share: it marks the share button, and brings the tab forward
 * with a notice when nobody is looking at it. Stopping needs no press and
 * happens at once.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { CallState } from "@/app/(app)/chat/call-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CallRecording } from "@/app/(app)/chat/call-recorder";

const mocks = vi.hoisted(() => ({
    ask: vi.fn(),
    clear: vi.fn(),
    notify: vi.fn(async () => null),
    watched: true
}));

vi.mock("@/app/(app)/chat/call-seat", () => ({ keepSeat: async () => undefined }));
vi.mock("@/app/(app)/chat/call-share-ask", () => ({
    askToShare: mocks.ask,
    clearShareAsk: mocks.clear
}));
vi.mock("@/lib/desktop-notify", () => ({
    notifyDesktop: mocks.notify,
    tabIsWatched: () => mocks.watched
}));

const { useCallRemote } = await import("@/app/(app)/chat/call-remote-hook");
const { emitCallRemote } = await import("@/lib/chat/call-remote");

const MEETING = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const recording = { running: false, supported: true } as unknown as CallRecording;

function mount(sharing: boolean) {
    const toggleShare = vi.fn();
    const call = {
        micOn: true,
        deafened: false,
        cameraOn: false,
        sharing,
        participantId: "p1",
        ended: false,
        toggleShare
    } as unknown as CallState;
    renderHook(() => useCallRemote(MEETING, call, recording, () => undefined), {
        wrapper: MessagesWrapper
    });
    return toggleShare;
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.watched = true;
});

describe("the share key in the tab", () => {
    it("marks the share button instead of opening a picker it may not open", () => {
        const toggleShare = mount(false);
        act(() => emitCallRemote({ command: "share", on: true }));
        expect(mocks.ask).toHaveBeenCalledTimes(1);
        expect(toggleShare).not.toHaveBeenCalled();
        // Looked at already: no notice on top of the marked button.
        expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("brings a tab nobody is looking at forward with a notice", () => {
        mocks.watched = false;
        mount(false);
        act(() => emitCallRemote({ command: "share", on: true }));
        expect(mocks.notify).toHaveBeenCalledWith(
            expect.objectContaining({ tag: `call-share-${MEETING}` })
        );
    });

    it("stops a running share at once", () => {
        const toggleShare = mount(true);
        act(() => emitCallRemote({ command: "share", on: false }));
        expect(toggleShare).toHaveBeenCalledTimes(1);
        expect(mocks.ask).not.toHaveBeenCalled();
    });
});
