// @vitest-environment jsdom

/**
 * What is wrong with the microphone, marked on the microphone.
 *
 * The notices of a call are one line now, and the one about the microphone can
 * be behind a count. So the microphone button carries it as well: a dot in the
 * notice's colour, and its words in the button's description and title, where a
 * screen reader and a pointer find them.
 */

import { CallRoom } from "@/app/(app)/chat/call-room";
import { cleanup, render, screen } from "@testing-library/react";
import type { CallState } from "@/app/(app)/chat/use-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recording = { supported: true, seconds: 0, start: () => undefined, stop: () => undefined };
vi.mock("@/app/(app)/chat/call-session", () => ({ useHeldCall: () => ({ recording }) }));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({}));
vi.mock("@/app/(app)/chat/soundboard-actions", () => ({
    favoriteSoundAction: async () => ({}),
    playSoundAction: async () => ({})
}));
// The panels around the room, which are not what this is about.
const notices: { mic: { short: string; severity: "error" | "warning" } | null } = { mic: null };
vi.mock("@/app/(app)/chat/call-notice-strip", () => ({
    CallNoticeStrip: () => null,
    useCallNotices: () => ({ top: notices.mic, rest: [], consequences: [], mic: notices.mic })
}));
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

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error: "Not in this call." }, { status: 410 }))
    );
});

afterEach(() => {
    cleanup();
    notices.mic = null;
});

function room() {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    return render(
        <CallRoom
            meetingId="m1"
            place="channel"
            call={callWith()}
            onLeave={() => undefined}
            viewerId="alan"
        />
    );
}

/** The microphone button, found by the name it has while the microphone is on (the test reads the catalogue keys). */
const micButton = () => screen.getByRole("button", { name: /callRoom\.mute$/ });

describe("the microphone badge", () => {
    it("is not there while nothing is wrong with the microphone", () => {
        room();
        const button = micButton();
        expect(button.getAttribute("aria-describedby")).toBeNull();
        expect(button.parentElement?.querySelector(".bg-danger, .bg-warning")).toBeNull();
    });

    it("marks an error in the danger colour and says it", () => {
        notices.mic = { short: "Your mic is not being sent", severity: "error" };
        room();
        const button = micButton();
        const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
        expect(described?.textContent).toBe("Your mic is not being sent");
        expect(button.getAttribute("title")).toContain("Your mic is not being sent");
        expect(button.parentElement?.querySelector(".bg-danger")).not.toBeNull();
    });

    it("marks a warning in the warning colour", () => {
        notices.mic = { short: "Your mic hears nothing", severity: "warning" };
        room();
        const dot = micButton().parentElement?.querySelector(".bg-warning");
        expect(dot).not.toBeNull();
        expect(dot?.getAttribute("aria-hidden")).toBe("true");
    });
});
