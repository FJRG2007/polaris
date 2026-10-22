// @vitest-environment jsdom

/**
 * Hanging up is heard, whichever control did it.
 *
 * The room's own button sounded it and nothing else did: the bar over other
 * screens, ending a meeting and a deck key all left the call in silence. The
 * provider's `leave` is the one door all of them go through, so it plays it -
 * once a hang-up, and not at all when there was no call to leave.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallSession } from "@/app/(app)/chat/call-hold";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const SESSION: CallSession = {
    meetingId: "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
    channelId: "019f8506-21f4-7173-a097-47c1fe63a88b",
    title: "Standup"
};
const VIEWER = "019f0000-0000-7000-8000-000000000001";

const played = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/chat/use-call", () => ({ useCall: () => ({ ended: false }) }));
vi.mock("@/app/(app)/chat/call-recorder", () => ({
    useCallRecorder: () => ({ running: false, stop: () => undefined })
}));
vi.mock("@/app/(app)/chat/call-audio", () => ({ CallAudio: () => null }));
vi.mock("@/app/(app)/chat/recording-panel", () => ({ RecordingPanel: () => null }));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/components/presence-store", () => ({ usePresenceRefresh: () => () => undefined }));
vi.mock("@/lib/call-sounds", () => ({ playCallSound: played }));

import { CallProvider, useCallHold } from "@/app/(app)/chat/call-session";

function Controls() {
    const { enter, leave } = useCallHold();
    return (
        <>
            <button type="button" onClick={() => enter(SESSION, false)}>
                join
            </button>
            <button type="button" onClick={leave}>
                hang up
            </button>
        </>
    );
}

afterEach(() => {
    cleanup();
    played.mockReset();
});

describe("hanging up a held call", () => {
    it("plays the hang-up sound once", () => {
        render(
            <CallProvider viewerId={VIEWER}>
                <Controls />
            </CallProvider>
        );
        fireEvent.click(screen.getByText("join"));
        fireEvent.click(screen.getByText("hang up"));
        // A second press lands on no call at all.
        fireEvent.click(screen.getByText("hang up"));

        expect(played.mock.calls).toEqual([["hangUp"]]);
    });

    it("plays nothing when there was no call to leave", () => {
        render(
            <CallProvider viewerId={VIEWER}>
                <Controls />
            </CallProvider>
        );
        fireEvent.click(screen.getByText("hang up"));

        expect(played).not.toHaveBeenCalled();
    });
});
