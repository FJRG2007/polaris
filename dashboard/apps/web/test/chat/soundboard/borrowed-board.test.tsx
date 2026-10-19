// @vitest-environment jsdom

/**
 * A call's soundboard, opened before its own answer has arrived.
 *
 * It opens on the last call's sounds rather than a spinner - but that call may
 * be in another space, so what that space decided (who may play) is not carried
 * over, and a failed ask never leaves the other call's board standing.
 */

import { MessagesWrapper } from "../../setup/i18n";
import type { CallState } from "@/app/(app)/chat/call-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/chat/soundboard-actions", () => ({
    favoriteSoundAction: async () => ({}),
    playSoundAction: async () => ({}),
    stopSoundAction: async () => ({})
}));

const { SoundboardButton } = await import("@/app/(app)/chat/soundboard-picker");

const call = {
    micOn: true,
    deafened: false,
    moderation: { serverMuted: false, serverDeafened: false }
} as unknown as CallState;

const deniedBoard = {
    refusal: "denied",
    external: true,
    groups: [],
    favorites: [],
    manageSpaceId: null,
    cooldownMs: 1000
};

function button(meetingId: string) {
    return render(
        <MessagesWrapper>
            <SoundboardButton meetingId={meetingId} call={call} />
        </MessagesWrapper>
    );
}

/** The soundboard button, whatever its label says. */
const trigger = () => screen.getByRole("button") as HTMLButtonElement;

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("a soundboard opened on another call's board", () => {
    it("does not carry that call's refusal, and a failed ask leaves nothing of it", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ board: deniedBoard }))
        );
        const first = button("11111111-1111-4111-8111-111111111111");
        await waitFor(() => expect(trigger().disabled).toBe(true));
        first.unmount();

        let answer: (response: Response) => void = () => undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)))
        );
        button("22222222-2222-4222-8222-222222222222");
        expect(trigger().disabled).toBe(false);

        await act(async () => answer(Response.json({ error: "Not here" }, { status: 403 })));
        expect(trigger().disabled).toBe(false);
    });

    it("drops that call's sounds when this call's own ask fails", async () => {
        const sound = {
            id: "space:s1:a1",
            spaceId: "s1",
            name: "Airhorn",
            emoji: "📯",
            volume: 1,
            durationMs: 1000,
            uploaderName: null,
            createdAt: "2026-01-01T00:00:00.000Z"
        };
        const group = { spaceId: "s1", spaceName: "Crew", here: true, sounds: [sound] };
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({ board: { ...deniedBoard, refusal: null, groups: [group] } })
            )
        );
        const first = button("33333333-3333-4333-8333-333333333333");
        fireEvent.click(trigger());
        await screen.findByRole("button", { name: "Play Airhorn" });
        first.unmount();

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ error: "Not here" }, { status: 403 }))
        );
        button("44444444-4444-4444-8444-444444444444");
        fireEvent.click(screen.getByRole("button", { name: "Soundboard" }));
        await screen.findByText("Loading sounds");
        expect(screen.queryByRole("button", { name: "Play Airhorn" })).toBeNull();
    });
});
