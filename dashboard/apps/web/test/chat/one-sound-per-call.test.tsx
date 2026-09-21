// @vitest-environment jsdom

/**
 * One call, one sound.
 *
 * Two of them reach for the speakers when a call arrives and only one of them
 * can be heard at a time. The tab's own ring is the good one - it repeats, it is
 * Polaris' own tone - but a browser refuses it outright until the page has been
 * interacted with, which is exactly the state a tab nobody has touched is in.
 * The notice the operating system draws is the other, and it is the only one that
 * reaches somebody in another window.
 *
 * So the notice rings only where the ring cannot be heard. Both of them at once
 * is what "saturadísimo" sounded like: two unrelated tones over each other for
 * one event.
 */

import { IncomingCalls } from "@/components/incoming-calls";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let onFrame: ((frame: unknown, context: { owner: boolean }) => void) | null = null;
/** Whether the tab's own audio would be heard, as `call-sounds` answers it. */
let audible = true;
/** Every notice the worker was asked to draw. */
let notices: { title: string; sound?: boolean }[] = [];

vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "scope" }));
vi.mock("@/app/(app)/chat/call-hold", () => ({ useHeldCall: () => null }));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown, context: { owner: boolean }) => void) => {
        onFrame = handler;
    }
}));

vi.mock("@/lib/shared-stream", () => ({
    openPeerChannel: () => ({ post: () => undefined, close: () => undefined })
}));

vi.mock("@/lib/desktop-notify", () => ({
    notifyDesktop: async (input: { title: string; sound?: boolean }) => {
        notices.push(input);
        return { close: () => undefined };
    },
    // Nobody is looking at the tab, which is the only state that draws one.
    tabIsWatched: () => false,
    mayNotify: async () => true,
    noticeStanding: () => "granted"
}));

vi.mock("@/lib/call-sounds", () => ({
    RING_FOR_MS: 30_000,
    playCallSound: () => undefined,
    startRinging: () => () => undefined,
    canBeHeard: () => audible
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({ callElsewhereAction: async () => null }));

/** Every claim this tab asked its device for. */
let claims: string[] = [];

vi.mock("@/lib/device-once", () => ({
    claimForDevice: async (key: string) => {
        claims.push(key);
        return true;
    }
}));

/**
 * Everything the effects have started, drained.
 *
 * A notice is drawn from a promise chain an effect starts - a claim, then the
 * permission, then the notice itself - and each hop is a microtask. Draining a
 * bounded number of them happens at the same speed on any machine; waiting for a
 * deadline does not, which is how a test passes alone and fails in a full run.
 */
async function settled(): Promise<void> {
    for (let hop = 0; hop < 6; hop += 1) await act(async () => undefined);
}

const ring = {
    kind: "call",
    state: "ringing",
    channelId: "c1",
    meetingId: "m1",
    count: 1,
    userId: "grace",
    name: "Grace"
};

beforeEach(() => {
    onFrame = null;
    notices = [];
    claims = [];
    audible = true;
    // No localStorage in this environment, which is the state `device-once`
    // treats as a device of one tab: the claim resolves and the notice is drawn.
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("a call arriving while nobody is looking at the tab", () => {
    it("lets the notice ring when the tab's own sound cannot be", async () => {
        audible = false;
        render(<IncomingCalls viewerId="ada" />);

        await act(async () => onFrame?.(ring, { owner: true }));
        expect(screen.queryByText("Grace is calling")).toBeTruthy();

        await settled();
        expect(notices).toHaveLength(1);
        expect(notices[0]?.sound).toBe(true);
    });

    it("answers for the sound and the notice with one claim", async () => {
        // With a claim each they could fall to different tabs of one device, and
        // then each believed the other was making the sound: the ringing tab was
        // one whose audio the browser had never allowed, the notice tab stayed
        // silent because "the ring is already sounding", and the call arrived in
        // silence. Whoever holds this knows whether its own ring can be heard.
        render(<IncomingCalls viewerId="ada" />);

        await act(async () => onFrame?.(ring, { owner: true }));

        await settled();
        expect(notices).toHaveLength(1);
        expect(new Set(claims).size).toBe(1);
        expect(claims[0]).toContain("m1");
    });

    it("keeps the notice silent when the ring is already sounding", async () => {
        audible = true;
        render(<IncomingCalls viewerId="ada" />);

        await act(async () => onFrame?.(ring, { owner: true }));

        await settled();
        expect(notices).toHaveLength(1);
        // The ring is the sound. A chime over the top of it is two noises for
        // one call, which is what somebody hears as distortion.
        expect(notices[0]?.sound).toBe(false);
    });
});
