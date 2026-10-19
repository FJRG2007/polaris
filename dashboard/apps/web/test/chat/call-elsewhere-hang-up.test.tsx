// @vitest-environment jsdom

/**
 * The call this browser just hung up, asked about again.
 *
 * Its seat lingers on the server for the moment the leave takes to land, so the
 * card would offer to "move" the call just left. That is held back - but only
 * for that moment: the same call rejoined from another device afterwards is
 * exactly what the card is for.
 */

import { MessagesWrapper } from "../setup/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    ask: vi.fn(),
    session: null as { meetingId: string } | null,
    onFrame: null as ((frame: { kind: string; voice?: boolean }) => void) | null
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/(app)/chat/call-session", () => ({
    useCallHold: () => ({ session: mocks.session, enter: vi.fn() })
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: { kind: string; voice?: boolean }) => void) => {
        mocks.onFrame = handler;
    }
}));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({ joinCallAction: vi.fn() }));
vi.mock("@/lib/chat/call-elsewhere-request", () => ({ askCallElsewhere: mocks.ask }));

const { CallElsewhere } = await import("@/app/(app)/chat/call-elsewhere");

const call = (meetingId: string) => ({ meetingId, channelId: "c1", title: "Standup" });
const tree = () => (
    <MessagesWrapper>
        <CallElsewhere />
    </MessagesWrapper>
);

/** Hang up m1 in this browser, with the server still holding its seat. */
async function hangUp() {
    mocks.session = { meetingId: "m1" };
    const view = render(tree());
    mocks.session = null;
    mocks.ask.mockResolvedValue(call("m1"));
    await act(async () => view.rerender(tree()));
    expect(screen.queryByRole("status")).toBeNull();
}

async function callFrame() {
    await act(async () => mocks.onFrame?.({ kind: "call" }));
}

beforeEach(() => {
    mocks.ask.mockReset();
    mocks.session = null;
    mocks.onFrame = null;
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("the call-on-another-device card after a hang-up", () => {
    it("offers the call again once the server has let the seat go", async () => {
        await hangUp();
        mocks.ask.mockResolvedValue(null);
        await callFrame();

        mocks.ask.mockResolvedValue(call("m1"));
        await callFrame();
        expect(screen.getByRole("status")).toBeTruthy();
    });

    it("offers the call again once the leave window has passed", async () => {
        vi.useFakeTimers();
        await hangUp();
        await act(async () => vi.advanceTimersByTime(10_000));

        await callFrame();
        expect(screen.getByRole("status")).toBeTruthy();
    });
});
