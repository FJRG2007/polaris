// @vitest-environment jsdom

/**
 * A tile only restarts when its picture actually changed.
 *
 * With a server in the middle, what everybody is sending is worked out fresh on
 * every track event in the room - somebody joining, somebody muting, somebody
 * sharing a screen. Each of those arrives several times a minute in a call of
 * six. The stream object is what a video element is pointed at, and pointing one
 * at a different object tears it down and starts it again: a black frame, a
 * re-attach, and on a wall of faces all of them at once, every time anybody does
 * anything.
 *
 * So the assertion is about object identity rather than contents, which is the
 * only thing a video element cares about.
 */

import { describe, expect, it } from "vitest";
import { settle } from "@/app/(app)/chat/call-media";

/** jsdom has no `MediaStream`, and what is being tested is identity and track
 *  ids - so this is the smallest thing that answers both. */
class FakeStream {
    constructor(private readonly tracks: { id: string }[]) {}
    getTracks() {
        return this.tracks;
    }
    getTrackById(id: string) {
        return this.tracks.find((track) => track.id === id) ?? null;
    }
}

Object.defineProperty(globalThis, "MediaStream", { value: FakeStream, writable: true });

function track(id: string): MediaStreamTrack {
    return { id } as MediaStreamTrack;
}

const settled = (
    held: Map<string, MediaStream>,
    found: Map<string, MediaStreamTrack[]>
): Map<string, MediaStream> => new Map(settle(held, found));

describe("keeping a tile where it is", () => {
    it("hands back the same stream when nothing about somebody changed", () => {
        const camera = track("cam-1");
        const before = settled(new Map(), new Map([["ada", [camera]]]));
        const after = settled(before, new Map([["ada", [camera]]]));

        expect(after.get("ada")).toBe(before.get("ada"));
    });

    it("leaves everybody else alone when one person turns a camera on", () => {
        const before = settled(
            new Map(),
            new Map([
                ["ada", [track("ada-mic")]],
                ["grace", [track("grace-mic")]]
            ])
        );
        const after = settled(
            before,
            new Map([
                ["ada", [track("ada-mic")]],
                ["grace", [track("grace-mic"), track("grace-cam")]]
            ])
        );

        // The one that changed is new, and it is the only one. This is the whole
        // point: a room of six should not flicker because one person did
        // something.
        expect(after.get("grace")).not.toBe(before.get("grace"));
        expect(after.get("ada")).toBe(before.get("ada"));
    });

    it("gives a new stream when a camera is swapped for another one", () => {
        const before = settled(new Map(), new Map([["ada", [track("cam-1")]]]));
        const after = settled(before, new Map([["ada", [track("cam-2")]]]));

        // The same number of tracks and a completely different picture, which is
        // why this compares ids rather than counts.
        expect(after.get("ada")).not.toBe(before.get("ada"));
    });

    it("drops somebody who has gone", () => {
        const before = settled(
            new Map(),
            new Map([
                ["ada", [track("ada-mic")]],
                ["grace", [track("grace-mic")]]
            ])
        );
        const after = settled(before, new Map([["ada", [track("ada-mic")]]]));

        expect(after.has("grace")).toBe(false);
        expect(after.get("ada")).toBe(before.get("ada"));
    });

    it("keeps a stream that has emptied without replacing it twice", () => {
        const before = settled(new Map(), new Map([["ada", []]]));
        const after = settled(before, new Map([["ada", []]]));

        // Somebody who has joined and published nothing yet is in the room with
        // an empty stream, and staying that way is not a change.
        expect(after.get("ada")).toBe(before.get("ada"));
    });
});
