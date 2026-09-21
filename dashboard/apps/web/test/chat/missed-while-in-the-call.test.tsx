// @vitest-environment jsdom

/**
 * A missed call that stopped being one.
 *
 * Somebody who is not picked up rings again, and the second attempt is the one
 * that gets answered. The first is still out there giving up, and when it did it
 * left a card reading "Missed call" above a conversation the reader was in the
 * middle of having - with a Call back button for the person they were talking
 * to, and nothing that would take it away but a press.
 *
 * Being in a call with them is the answer to their call, whichever attempt it
 * was placed on. Both orders are pinned here, because they are different code
 * paths: the card can be left before the call is joined, or the attempt can give
 * up after.
 */

import { IncomingCalls } from "@/components/incoming-calls";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let onFrame: ((frame: unknown, context: { owner: boolean }) => void) | null = null;
/** The call this browser is sitting in, as the provider would report it. */
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
    openPeerChannel: () => ({ post: () => undefined, close: () => undefined })
}));

vi.mock("@/lib/desktop-notify", () => ({
    notifyDesktop: async () => null,
    tabIsWatched: () => true,
    mayNotify: async () => false,
    noticeStanding: () => "granted"
}));

vi.mock("@/lib/call-sounds", () => ({
    RING_FOR_MS: 30_000,
    playCallSound: () => undefined,
    startRinging: () => () => undefined
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({
    callElsewhereAction: async () => null
}));

/** Grace calling, in whichever conversation. */
const ring = (meetingId: string, channelId = "c1") => ({
    kind: "call",
    state: "ringing",
    channelId,
    meetingId,
    count: 1,
    userId: "grace",
    name: "Grace"
});

/** The same call giving up: the room closed with nobody but the caller in it. */
const gaveUp = (meetingId: string, channelId = "c1") => ({
    ...ring(meetingId, channelId),
    state: "ended",
    count: 0
});

beforeEach(() => {
    onFrame = null;
    session = null;
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("a missed call while the reader is on the phone", () => {
    it("goes when the second attempt is answered", async () => {
        const view = render(<IncomingCalls viewerId="ada" />);
        onFrame?.(ring("m1"), { owner: true });
        // Awaited between the two: the card is drawn from state, and a frame
        // arriving in the same tick as the one before it finds a component that
        // has not been told about the first yet.
        expect(await screen.findByText("Grace is calling")).toBeTruthy();
        onFrame?.(gaveUp("m1"), { owner: true });
        expect(await screen.findByText("Missed call")).toBeTruthy();

        // They rang again and this time it was picked up, in the same
        // conversation the missed one was in.
        session = { meetingId: "m2", channelId: "c1", title: "Grace" };
        view.rerender(<IncomingCalls viewerId="ada" />);

        await vi.waitFor(() => expect(screen.queryByText("Missed call")).toBeNull());
    });

    it("is never left behind when the call was already answered", async () => {
        // The other order: the second attempt was answered first, and the first
        // one gives up afterwards - which is the usual one, because a caller
        // rings again before the first attempt has run out.
        session = { meetingId: "m2", channelId: "c1", title: "Grace" };
        render(<IncomingCalls viewerId="ada" />);
        onFrame?.(ring("m1"), { owner: true });
        expect(await screen.findByText("Grace is calling")).toBeTruthy();
        onFrame?.(gaveUp("m1"), { owner: true });

        await vi.waitFor(() => expect(screen.queryByText("Grace is calling")).toBeNull());
        expect(screen.queryByText("Missed call")).toBeNull();
    });

    it("keeps one from somebody else, which is the call worth coming back to", async () => {
        session = { meetingId: "m2", channelId: "c1", title: "Grace" };
        render(<IncomingCalls viewerId="ada" />);
        onFrame?.(ring("m9", "c2"), { owner: true });
        expect(await screen.findByText("Grace is calling")).toBeTruthy();
        onFrame?.(gaveUp("m9", "c2"), { owner: true });

        expect(await screen.findByText("Missed call")).toBeTruthy();
    });
});
