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
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper } from "../setup/i18n";

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

/** What this tab told the others, and the way the others talk to it. */
const posted: unknown[] = [];
let fromPeer: ((message: unknown) => void) | null = null;
vi.mock("@/lib/shared-stream", () => ({
    openPeerChannel: (_name: string, _scope: string, onMessage: (message: unknown) => void) => {
        fromPeer = onMessage;
        return { post: (message: unknown) => void posted.push(message), close: () => undefined };
    }
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
    startRinging: () => () => undefined,
    // Audible, so the notice these tests draw stays silent - which is not what
    // they are about, but it has to be one or the other.
    willBeHeard: async () => true
}));

vi.mock("@/lib/chat/call-elsewhere-request", () => ({
    askCallElsewhere: async () => null
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
    fromPeer = null;
    posted.length = 0;
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("a missed call while the reader is on the phone", () => {
    it("goes when the second attempt is answered", async () => {
        const view = render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        // Flushed one at a time: the card is drawn from state, and a frame
        // arriving in the same tick as the one before it finds a component that
        // has not been told about the first yet.
        await act(async () => onFrame?.(ring("m1"), { owner: true }));
        expect(screen.queryByText("Grace is calling")).toBeTruthy();
        await act(async () => onFrame?.(gaveUp("m1"), { owner: true }));
        expect(screen.queryByText("Missed call")).toBeTruthy();

        // They rang again and this time it was picked up, in the same
        // conversation the missed one was in.
        session = { meetingId: "m2", channelId: "c1", title: "Grace" };
        await act(async () => view.rerender(<IncomingCalls viewerId="ada" />));

        expect(screen.queryByText("Missed call")).toBeNull();
    });

    it("is never left behind when the call was already answered", async () => {
        // The other order: the second attempt was answered first, and the first
        // one gives up afterwards - which is the usual one, because a caller
        // rings again before the first attempt has run out.
        session = { meetingId: "m2", channelId: "c1", title: "Grace" };
        render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        await act(async () => onFrame?.(ring("m1"), { owner: true }));
        expect(screen.queryByText("Grace is calling")).toBeTruthy();
        await act(async () => onFrame?.(gaveUp("m1"), { owner: true }));

        expect(screen.queryByText("Grace is calling")).toBeNull();
        expect(screen.queryByText("Missed call")).toBeNull();
    });

    it("keeps one from somebody else, which is the call worth coming back to", async () => {
        session = { meetingId: "m2", channelId: "c1", title: "Grace" };
        render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        await act(async () => onFrame?.(ring("m9", "c2"), { owner: true }));
        expect(screen.queryByText("Grace is calling")).toBeTruthy();
        await act(async () => onFrame?.(gaveUp("m9", "c2"), { owner: true }));

        expect(screen.queryByText("Missed call")).toBeTruthy();
    });
});

describe("a missed call that was answered somewhere else", () => {
    /** A card for Grace's missed call, on screen. */
    async function missedOne(): Promise<void> {
        render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        await act(async () => onFrame?.(ring("m1"), { owner: true }));
        await act(async () => onFrame?.(gaveUp("m1"), { owner: true }));
        expect(screen.queryByText("Missed call")).toBeTruthy();
    }

    it("goes when the reader calls back from another device", async () => {
        await missedOne();
        await act(async () =>
            onFrame?.({ ...ring("m2"), userId: "ada", name: "Ada", count: 1 }, { owner: true })
        );
        expect(screen.queryByText("Missed call")).toBeNull();
    });

    it("goes when the reader joins a call there from another device", async () => {
        await missedOne();
        await act(async () =>
            onFrame?.(
                { ...ring("m2"), state: "moved", userId: "ada", name: "Ada", count: 2 },
                { owner: true }
            )
        );
        expect(screen.queryByText("Missed call")).toBeNull();
    });

    it("gives way to a later call ringing in the same conversation", async () => {
        await missedOne();
        await act(async () => onFrame?.(ring("m2"), { owner: true }));
        expect(screen.queryByText("Missed call")).toBeNull();
        expect(screen.queryByText("Grace is calling")).toBeTruthy();
    });

    it("goes when another tab dealt with it, and a dismissal here tells the others", async () => {
        await missedOne();
        await act(async () => fromPeer?.({ kind: "missed-cleared", channelId: "c1" }));
        expect(screen.queryByText("Missed call")).toBeNull();

        await act(async () => onFrame?.(ring("m3"), { owner: true }));
        await act(async () => onFrame?.(gaveUp("m3"), { owner: true }));
        expect(screen.queryByText("Missed call")).toBeTruthy();
        await act(async () => screen.getByRole("button", { name: "Dismiss" }).click());
        expect(screen.queryByText("Missed call")).toBeNull();
        expect(posted).toContainEqual({ kind: "missed-cleared", channelId: "c1" });
    });

    it("keeps a missed call from another conversation", async () => {
        await missedOne();
        await act(async () =>
            onFrame?.(
                { ...ring("m2", "c2"), state: "moved", userId: "ada", name: "Ada", count: 2 },
                { owner: true }
            )
        );
        expect(screen.queryByText("Missed call")).toBeTruthy();
    });
});
