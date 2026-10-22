// @vitest-environment jsdom

/**
 * A soundboard press is heard the moment it lands.
 *
 * The person who pressed hears it here at once, not when the room carries it
 * back; the room's copy of that press is then not played a second time, while
 * somebody else pressing the same sound still is; and a press the server
 * refuses stops.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every element the player made, in order. */
let made: FakeAudio[] = [];

/** Whether the browser lets an element play. */
let playable = true;

class FakeAudio {
    src: string;
    volume = 1;
    preload = "";
    paused = true;
    private handlers = new Map<string, () => void>();
    constructor(src: string) {
        this.src = src;
        made.push(this);
    }
    addEventListener(name: string, handler: () => void) {
        this.handlers.set(name, handler);
    }
    play() {
        if (!playable) return Promise.reject(new Error("NotAllowedError"));
        this.paused = false;
        return Promise.resolve();
    }
    pause() {
        this.paused = true;
    }
}

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const REF = "default:applause";

/** Let every pending promise in the player settle. */
const settle = () => new Promise((done) => setTimeout(done, 0));

let player: typeof import("@/app/(app)/chat/soundboard-player");

beforeEach(async () => {
    made = [];
    playable = true;
    vi.resetModules();
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("RIFF", { status: 200 }))
    );
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:clip" }));
    player = await import("@/app/(app)/chat/soundboard-player");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("pressing a sound", () => {
    it("sounds here at once, and the room's copy of it is not played again", async () => {
        player.playOwnClip(REF, { volume: 0.5, channel: SELF });
        await settle();
        const playing = made.filter((element) => !element.paused);
        expect(playing).toHaveLength(1);
        expect(playing[0]?.volume).toBe(0.5);
        expect(player.clipsPlaying(SELF)).toBe(true);

        expect(player.ownEcho(SELF, REF)).toBe(true);
        // One press swallows one copy.
        expect(player.ownEcho(SELF, REF)).toBe(false);
    });

    it("does not swallow somebody else playing the same sound", () => {
        player.playOwnClip(REF, { volume: 1, channel: SELF });
        expect(player.ownEcho(OTHER, REF)).toBe(false);
        expect(player.ownEcho(SELF, "default:rimshot")).toBe(false);
    });

    it("stops, and expects nothing, when the server refuses the play", async () => {
        const own = player.playOwnClip(REF, { volume: 1, channel: SELF });
        await settle();
        own.undo();
        await settle();
        expect(made.every((element) => element.paused)).toBe(true);
        expect(player.clipsPlaying(SELF)).toBe(false);
        expect(player.ownEcho(SELF, REF)).toBe(false);
    });

    it("expects no copy when nobody else is connected", () => {
        const own = player.playOwnClip(REF, { volume: 1, channel: SELF });
        own.settle();
        expect(player.ownEcho(SELF, REF)).toBe(false);
    });

    it("needs no fetch on the press once the clip was warmed", async () => {
        player.warmClips([REF]);
        await settle();
        const fetched = vi.mocked(fetch).mock.calls.length;
        expect(fetched).toBe(1);
        // Ready before the press: an element already made for it.
        expect(made).toHaveLength(1);
        player.playOwnClip(REF, { volume: 1, channel: SELF });
        await settle();
        expect(vi.mocked(fetch).mock.calls.length).toBe(fetched);
        expect(made[0]?.paused).toBe(false);
    });

    it("lets the room's copy play when the press could not sound here", async () => {
        playable = false;
        player.playOwnClip(REF, { volume: 1, channel: SELF });
        await settle();
        expect(player.clipsPlaying(SELF)).toBe(false);
        expect(player.ownEcho(SELF, REF)).toBe(false);
    });

    it("gives two plays of one sound an element each", async () => {
        player.warmClips([REF]);
        await settle();
        void player.playClip(REF, { volume: 1, channel: SELF });
        void player.playClip(REF, { volume: 1, channel: OTHER });
        await settle();
        const playing = made.filter((element) => !element.paused);
        expect(playing).toHaveLength(2);
        expect(playing[0]).not.toBe(playing[1]);
        player.stopClips(SELF);
        expect(player.clipsPlaying(OTHER)).toBe(true);
        expect(made.filter((element) => !element.paused)).toHaveLength(1);
    });
});
