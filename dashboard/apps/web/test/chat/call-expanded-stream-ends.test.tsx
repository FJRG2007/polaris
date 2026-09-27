// @vitest-environment jsdom

/**
 * A call expanded to the whole column while a stream was on its stage, and the
 * stream then going.
 *
 * It used to keep the column: an expanded call with nothing left to watch, and
 * the conversation hidden behind it. Now the column is given back when what was
 * being watched goes - and only then, so a call somebody expanded with nothing on
 * the stage stays the size they asked for.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CallRoom } from "@/app/(app)/chat/call-room";
import type { CallState } from "@/app/(app)/chat/use-call";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/app/(app)/chat/call-session", () => ({ useHeldCall: () => null }));
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

/** A stream with one live picture in it, as far as the room asks. */
function screenStream(): MediaStream {
    const track = {
        kind: "video",
        readyState: "live",
        id: "t1",
        addEventListener() {},
        removeEventListener() {}
    };
    return {
        id: "s1",
        getVideoTracks: () => [track],
        getAudioTracks: () => [],
        getTracks: () => [track],
        addEventListener() {},
        removeEventListener() {}
    } as unknown as MediaStream;
}

/** The call, with only what a room of two and one shared screen needs. Anything
 *  else is a function that does nothing or an empty value. */
function callWith(screens: ReadonlyMap<string, MediaStream>): CallState {
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

describe("an expanded call whose stream ends", () => {
    it("gives the column back when there is nothing left to watch", () => {
        HTMLMediaElement.prototype.play = () => Promise.resolve();
        const onExpand = vi.fn();
        const room = (screens: ReadonlyMap<string, MediaStream>) => (
            <CallRoom
                meetingId="m1"
                place="channel"
                call={callWith(screens)}
                onLeave={() => undefined}
                expanded
                onExpand={onExpand}
            />
        );
        const view = render(room(new Map([["p-alan", screenStream()]])));
        expect(onExpand).not.toHaveBeenCalled();
        view.rerender(room(new Map()));
        expect(onExpand).toHaveBeenCalledWith(false);
    });

    it("stays expanded when it was expanded with nothing being watched", () => {
        HTMLMediaElement.prototype.play = () => Promise.resolve();
        const onExpand = vi.fn();
        const room = () => (
            <CallRoom
                meetingId="m1"
                place="channel"
                call={callWith(new Map())}
                onLeave={() => undefined}
                expanded
                onExpand={onExpand}
            />
        );
        const view = render(room());
        view.rerender(room());
        expect(onExpand).not.toHaveBeenCalled();
    });
});
