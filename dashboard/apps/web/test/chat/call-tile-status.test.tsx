// @vitest-environment jsdom

/**
 * Where a tile says somebody cannot be heard.
 *
 * With the camera off a tile is a face in the middle of a card, and the crossed
 * microphone - or the crossed headphones - used to be a badge on that face's
 * circle. It is in the name plate now, ahead of the name, camera on or off, the
 * way a voice channel's tile carries it.
 */

import { CallRoom } from "@/app/(app)/chat/call-room";
import { cleanup, render, screen } from "@testing-library/react";
import type { CallState } from "@/app/(app)/chat/use-call";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/chat/call-session", () => ({ useHeldCall: () => null }));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({}));
vi.mock("@/app/(app)/chat/soundboard-actions", () => ({
    callSoundboardAction: async () => ({}),
    favoriteSoundAction: async () => ({}),
    playSoundAction: async () => ({})
}));
// The panels around the room, which are not what this is about.
vi.mock("@/app/(app)/chat/call-diagnosis-panel", () => ({ CallDiagnosisPanel: () => null }));
vi.mock("@/app/(app)/chat/no-audio-notice", () => ({ NoAudioNotice: () => null }));
vi.mock("@/app/(app)/chat/call-hands-panel", () => ({ HandStrip: () => null }));
vi.mock("@/app/(app)/chat/call-combine-panel", () => ({
    CombineRequestDialog: () => null,
    CombineStrip: () => null
}));
vi.mock("@/app/(app)/chat/actions", () => ({ searchPeopleAction: async () => ({ people: [] }) }));

/** The call, with only what a room of two and one shared screen needs. Anything
 *  else is a function that does nothing or an empty value. */
function callWith(states: ReadonlyMap<string, { muted?: boolean; deafened?: boolean }>): CallState {
    const base: Record<string, unknown> = {
        participantId: "p-ada",
        meeting: {
            hostId: "ada",
            participants: [
                { id: "p-ada", userId: "ada", name: "Ada", admission: "admitted" },
                { id: "p-alan", userId: "alan", name: "Alan", admission: "admitted" }
            ]
        },
        screens: new Map(),
        remote: new Map(),
        states,
        speaking: new Set(),
        reactions: [],
        hands: [],
        audioMembers: [],
        localScreen: null,
        localStream: null,
        ended: false,
        error: "",
        micOn: true,
        cameraOn: false,
        microphones: [],
        cameras: [],
        audio: { ok: true },
        moderation: { serverMuted: false, serverDeafened: false }
    };
    return new Proxy(base, {
        get: (target, key) => {
            if (typeof key !== "string" || key in target) return target[key as string];
            // The controls: pressed by nobody here.
            return /^(set|toggle|choose|refresh|pick|flip|combine|ask|answer|leave|lower|react)/.test(
                key
            )
                ? () => undefined
                : undefined;
        }
    }) as unknown as CallState;
}

afterEach(cleanup);

/** A room with Alan's camera off, in the state given. */
function room(state: { muted?: boolean; deafened?: boolean }) {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    render(
        <CallRoom
            meetingId="m1"
            place="room"
            call={callWith(new Map([["p-alan", state]]))}
            onLeave={() => undefined}
        />
    );
}

/** The plate Alan's name is written in. */
const plate = () => screen.getByText("Alan", { selector: "span" });

describe("a tile with the camera off", () => {
    it("says a muted microphone ahead of the name, not on the face", () => {
        room({ muted: true });
        const icon = screen.getByLabelText("chat.callRoom.microphoneOff");
        expect(icon.parentElement).toBe(plate());
        expect(icon.nextSibling?.textContent).toBe("Alan");
        expect(screen.queryByLabelText("components.avatar.microphoneOff")).toBeNull();
    });

    it("says deafened instead of muted when both are true", () => {
        room({ muted: true, deafened: true });
        expect(screen.getByLabelText("chat.callRoom.notListening").parentElement).toBe(plate());
        expect(screen.queryByLabelText("chat.callRoom.microphoneOff")).toBeNull();
    });

    it("says nothing for somebody who can be heard", () => {
        room({});
        expect(screen.queryByLabelText("chat.callRoom.microphoneOff")).toBeNull();
        expect(screen.queryByLabelText("chat.callRoom.notListening")).toBeNull();
    });
});
