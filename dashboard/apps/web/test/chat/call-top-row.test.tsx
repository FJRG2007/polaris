// @vitest-environment jsdom

/**
 * The row at the top of a call: the raised hand, recording and adding somebody.
 *
 * The hand used to sit in the control bar, which had grown past what reads at a
 * glance; it is in the top row now, beside the other things nobody reaches for
 * mid-sentence. Recording used to be the host's alone everywhere, so in a direct
 * message only whoever rang first could record - in a conversation of equals
 * anybody in it may.
 */

import { CallRoom } from "@/app/(app)/chat/call-room";
import { cleanup, render, screen } from "@testing-library/react";
import type { CallState } from "@/app/(app)/chat/use-call";
import { afterEach, describe, expect, it, vi } from "vitest";

const recording = { supported: true, seconds: 0, start: () => undefined, stop: () => undefined };
vi.mock("@/app/(app)/chat/call-session", () => ({ useHeldCall: () => ({ recording }) }));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({}));
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
function callWith(screens: ReadonlyMap<string, MediaStream> = new Map()): CallState {
    const base: Record<string, unknown> = {
        participantId: "p-ada",
        meeting: {
            hostId: "ada",
            participants: [
                { id: "p-ada", userId: "ada", name: "Ada", admission: "admitted" },
                { id: "p-alan", userId: "alan", name: "Alan", admission: "admitted" }
            ]
        },
        screens,
        remote: new Map(),
        states: new Map(),
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

/** The room as Alan sees it - Ada started the call, so Alan is not its host. */
function room(props: { viewerId?: string; mayRecord?: boolean }) {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    return render(
        <CallRoom
            meetingId="m1"
            place="channel"
            call={callWith()}
            onLeave={() => undefined}
            {...props}
        />
    );
}

/** The record button, found by the title it carries before a recording starts (the test reads the catalogue keys). */
const recordButton = () => document.querySelector('button[title$="writeThisCallToA"]');

describe("the top row of a call", () => {
    it("holds the raised hand, outside the control bar", () => {
        room({ viewerId: "alan" });
        const hand = screen.getByRole("button", { name: /raiseYourHand/ });
        expect(hand.parentElement).toBe(
            screen.getByRole("button", { name: /addPeople/ }).parentElement
        );
    });

    it("offers the hand to a guest, who has no account", () => {
        room({});
        expect(screen.getByRole("button", { name: /raiseYourHand/ })).toBeTruthy();
    });

    it("lets anybody in a direct message record, not only whoever rang", () => {
        room({ viewerId: "alan", mayRecord: true });
        expect(recordButton()).not.toBeNull();
    });

    it("keeps recording a channel call to its host", () => {
        room({ viewerId: "alan" });
        expect(recordButton()).toBeNull();
        cleanup();
        room({ viewerId: "ada" });
        expect(recordButton()).not.toBeNull();
    });

    it("never offers recording to a guest", () => {
        room({ mayRecord: true });
        expect(recordButton()).toBeNull();
    });
});
