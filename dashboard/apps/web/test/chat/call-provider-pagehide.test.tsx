// @vitest-environment jsdom

/**
 * The note `CallProvider` leaves as the page is left mid-call.
 *
 * `call-resume.test.ts` pins what the note is honoured for once it exists; this
 * pins that `CallProvider` actually writes one on `pagehide`, and only when the
 * page is really being left - a bfcache suspension (`event.persisted`) fires
 * `pagehide` too, and is not a departure, so it must write nothing.
 */

import type { CallSession } from "@/app/(app)/chat/call-hold";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const SESSION: CallSession = {
    meetingId: "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
    channelId: "019f8506-21f4-7173-a097-47c1fe63a88b",
    title: "Standup"
};
const VIEWER = "019f0000-0000-7000-8000-000000000001";
const KEY = "polaris.call.resume";

vi.mock("@/app/(app)/chat/use-call", () => ({
    useCall: () => ({ ended: false })
}));

vi.mock("@/app/(app)/chat/call-recorder", () => ({
    useCallRecorder: () => ({ running: false, stop: () => undefined })
}));

vi.mock("@/app/(app)/chat/call-audio", () => ({ CallAudio: () => null }));
vi.mock("@/app/(app)/chat/recording-panel", () => ({ RecordingPanel: () => null }));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/components/presence-store", () => ({ usePresenceRefresh: () => () => undefined }));
vi.mock("@/lib/call-sounds", () => ({ playCallSound: () => undefined }));

import { CallProvider, useCallHold } from "@/app/(app)/chat/call-session";

/** Puts this tab into the call, the way joining one really does - through the
 *  context `CallProvider` hands down, not by reaching into its state. */
function EnterCall() {
    const { enter } = useCallHold();
    return (
        <button type="button" onClick={() => enter(SESSION, false)}>
            join
        </button>
    );
}

/** `pagehide` carries `persisted`, which `Event` does not construct with. */
function pagehide(persisted: boolean): Event {
    return Object.assign(new Event("pagehide"), { persisted });
}

beforeEach(() => {
    window.sessionStorage.clear();
});

afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.clearAllMocks();
});

describe("leaving the page mid-call", () => {
    it("writes a resume note on a real pagehide", () => {
        render(
            <CallProvider viewerId={VIEWER}>
                <EnterCall />
            </CallProvider>
        );
        fireEvent.click(screen.getByText("join"));

        fireEvent(window, pagehide(false));

        const note = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null");
        expect(note?.session).toEqual(SESSION);
        expect(note?.reason).toBe("leaving");
    });

    it("writes nothing when the page is only suspended into bfcache", () => {
        render(
            <CallProvider viewerId={VIEWER}>
                <EnterCall />
            </CallProvider>
        );
        fireEvent.click(screen.getByText("join"));

        fireEvent(window, pagehide(true));

        expect(window.sessionStorage.getItem(KEY)).toBeNull();
    });

    it("writes nothing when this tab was never in a call", () => {
        render(
            <CallProvider viewerId={VIEWER}>
                <EnterCall />
            </CallProvider>
        );

        fireEvent(window, pagehide(false));

        expect(window.sessionStorage.getItem(KEY)).toBeNull();
    });
});
