// @vitest-environment jsdom

/**
 * One telephone, however many windows it is drawn in.
 *
 * A call arriving is announced to every tab the reader has open, which is right -
 * a telephone that only rings in the window they happen to be looking at is a
 * missed call. Only one of those tabs is ever answered, and the rest used to
 * find out never: the card went on offering to join a call that had been picked
 * up next door, the tab holding the connection went on ringing, and the notice
 * the operating system had drawn stayed up until somebody reloaded the page.
 *
 * So a tab that deals with a call says so on the channel the tabs share, and the
 * others put it down. Asserted from both ends here: what this tab says when it
 * is the one that acts, and what it does when another tab was.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IncomingCalls } from "@/components/incoming-calls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The frame handler `useChatStream` was given, so a call can be made to arrive. */
let onFrame: ((frame: unknown, context: { owner: boolean }) => void) | null = null;
/** What this tab told the other tabs. */
let posted: unknown[] = [];
/** The listener the peer channel was opened with, so another tab can speak. */
let onPeer: ((message: unknown) => void) | null = null;
let session: { meetingId: string; channelId: string; title: string } | null = null;

vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "scope" }));

vi.mock("@/app/(app)/chat/call-hold", () => ({
    useHeldCall: () => (session ? { session } : null)
}));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown, context: { owner: boolean }) => void) => {
        onFrame = handler;
    }
}));

vi.mock("@/lib/shared-stream", () => ({
    openPeerChannel: (_name: string, _scope: string, handler: (message: unknown) => void) => {
        onPeer = handler;
        return { post: (message: unknown) => posted.push(message), close: () => undefined };
    }
}));

vi.mock("@/lib/desktop-notify", () => ({
    notifyDesktop: async () => null,
    tabIsWatched: () => true
}));

vi.mock("@/lib/call-sounds", () => ({
    RING_FOR_MS: 30_000,
    playCallSound: () => undefined,
    startRinging: () => () => undefined
}));

/** A call coming in, as the stream announces one. */
const ring = (meetingId: string) => ({
    kind: "call",
    state: "ringing",
    channelId: "c1",
    meetingId,
    count: 1,
    userId: "grace",
    name: "Grace"
});

beforeEach(() => {
    onFrame = null;
    onPeer = null;
    posted = [];
    session = null;
});

afterEach(() => {
    // Every test here renders the same component, and `screen` searches the
    // whole document: a tree left mounted by the test before is a card the next
    // one finds and believes.
    cleanup();
    vi.clearAllMocks();
});

describe("a call ringing in several tabs", () => {
    it("puts it down when another tab has dealt with it", async () => {
        render(<IncomingCalls viewerId="ada" />);
        onFrame?.(ring("m1"), { owner: true });
        expect(await screen.findByText("Grace is calling")).toBeTruthy();

        // The other tab answered, or declined. Which of the two is nobody
        // else's business: both leave this tab with the same thing to do.
        onPeer?.({ kind: "settled", meetingId: "m1" });

        await vi.waitFor(() => expect(screen.queryByText("Grace is calling")).toBeNull());
    });

    it("ignores a message it cannot make sense of", async () => {
        render(<IncomingCalls viewerId="ada" />);
        onFrame?.(ring("m1"), { owner: true });
        expect(await screen.findByText("Grace is calling")).toBeTruthy();

        // A tab still running a previous build of Polaris is on this channel too.
        onPeer?.({ kind: "whatever" });
        onPeer?.("m1");

        expect(screen.queryByText("Grace is calling")).toBeTruthy();
    });

    it("tells the others when it is the tab that declines", async () => {
        render(<IncomingCalls viewerId="ada" />);
        onFrame?.(ring("m1"), { owner: true });
        fireEvent.click(await screen.findByLabelText("Decline"));

        expect(posted).toEqual([{ kind: "settled", meetingId: "m1" }]);
        await vi.waitFor(() => expect(screen.queryByText("Grace is calling")).toBeNull());
    });

    it("tells the others when the call was answered anywhere in Polaris", async () => {
        // Joined from the conversation's own Join, or from a voice room's strip:
        // the card is not the only way in, and being in the call is the fact
        // every other tab needs.
        session = { meetingId: "m1", channelId: "c1", title: "Grace" };
        render(<IncomingCalls viewerId="ada" />);

        await vi.waitFor(() => expect(posted).toEqual([{ kind: "settled", meetingId: "m1" }]));
    });
});
