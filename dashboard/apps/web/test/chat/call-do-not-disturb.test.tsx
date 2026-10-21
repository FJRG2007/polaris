// @vitest-environment jsdom

/**
 * A call arriving in do not disturb: the card is drawn and can be answered,
 * and nothing rings - no ringtone, no notice outside the window.
 */

import { MessagesWrapper } from "../setup/i18n";
import { IncomingCalls } from "@/components/incoming-calls";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let onFrame: ((frame: unknown, context: { owner: boolean }) => void) | null = null;
let quiet = false;
let notices: { title: string }[] = [];
let rings = 0;

vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "scope" }));
vi.mock("@/components/do-not-disturb", () => ({ useDoNotDisturb: () => quiet }));
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
    notifyDesktop: async (input: { title: string }) => {
        notices.push(input);
        return { close: () => undefined };
    },
    tabIsWatched: () => false,
    mayNotify: async () => true,
    noticeStanding: () => "granted"
}));
vi.mock("@/lib/call-sounds", () => ({
    RING_FOR_MS: 30_000,
    playCallSound: () => undefined,
    startRinging: () => {
        rings += 1;
        return () => undefined;
    },
    willBeHeard: async () => false
}));
vi.mock("@/lib/chat/call-elsewhere-request", () => ({ askCallElsewhere: async () => null }));
vi.mock("@/lib/device-once", () => ({ claimForDevice: async () => true }));

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
    rings = 0;
    quiet = false;
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("a call in do not disturb", () => {
    it("is shown in the app without a ring or a notice", async () => {
        quiet = true;
        render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        await act(async () => onFrame?.(ring, { owner: true }));
        expect(screen.queryByText("Grace is calling")).toBeTruthy();
        await settled();
        expect(rings).toBe(0);
        expect(notices).toHaveLength(0);
    });

    it("rings as before once do not disturb is off", async () => {
        render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        await act(async () => onFrame?.(ring, { owner: true }));
        await settled();
        expect(rings).toBe(1);
        expect(notices).toHaveLength(1);
    });
});
