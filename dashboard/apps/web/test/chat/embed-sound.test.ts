// @vitest-environment jsdom

/**
 * Whether a player in a message starts with its sound on, per site.
 *
 * What is asserted: a site nobody has muted starts with sound; a mute or an
 * unmute is remembered for that site alone; a stored value that does not parse,
 * or a storage that refuses, is sound on and never throws; and a player's own
 * mute on load is not taken for the reader's, which only counts once the player
 * has done what it was told.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    SOUND_START,
    embedMuted,
    parseEmbedMuted,
    setEmbedMuted,
    soundStep
} from "@/app/(app)/chat/embed-sound";

/** A store to read and write: this runtime's jsdom has no local storage of its
 *  own, so the thing being tested is given one. */
function storage(store: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">) {
    Object.defineProperty(window, "localStorage", { configurable: true, value: store });
}

beforeEach(() => {
    const kept = new Map<string, string>();
    storage({
        getItem: (key) => kept.get(key) ?? null,
        setItem: (key, value) => void kept.set(key, value),
        removeItem: (key) => void kept.delete(key),
        clear: () => kept.clear()
    });
});

describe("the remembered sound", () => {
    it("is on for a site nobody has muted", () => {
        expect(embedMuted("www.tiktok.com")).toBe(false);
    });

    it("remembers a mute and an unmute, per site", () => {
        setEmbedMuted("www.tiktok.com", true);
        expect(embedMuted("www.tiktok.com")).toBe(true);
        expect(embedMuted("player.example")).toBe(false);
        setEmbedMuted("player.example", true);
        setEmbedMuted("www.tiktok.com", false);
        expect(embedMuted("www.tiktok.com")).toBe(false);
        expect(embedMuted("player.example")).toBe(true);
    });

    it("is nothing chosen when what is stored does not parse", () => {
        expect(parseEmbedMuted(null)).toEqual({});
        expect(parseEmbedMuted("not json")).toEqual({});
        expect(parseEmbedMuted('{"www.tiktok.com":"yes"}')).toEqual({});
        expect(parseEmbedMuted("[true]")).toEqual({});
        expect(parseEmbedMuted('{"www.tiktok.com":true}')).toEqual({ "www.tiktok.com": true });
        window.localStorage.setItem("polaris.chat.embed-muted", "{broken");
        expect(embedMuted("www.tiktok.com")).toBe(false);
    });

    it("never throws when the browser refuses storage", () => {
        const refuse = () => {
            throw new Error("blocked");
        };
        storage({ getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse });
        expect(embedMuted("www.tiktok.com")).toBe(false);
        expect(() => setEmbedMuted("www.tiktok.com", true)).not.toThrow();
    });
});

describe("what a player's sound reports do", () => {
    it("answers the player's own mute on load, and remembers nothing for it", () => {
        // TikTok's player reports itself muted as it loads, before anything
        // was asked of it.
        const first = soundStep(SOUND_START, false, { muted: true });
        expect(first).toMatchObject({ ask: true, remember: null });
        const done = soundStep(first.state, false, { muted: false });
        expect(done).toMatchObject({ ask: false, remember: null });
        expect(done.state.settled).toBe(true);
    });

    it("remembers what the reader does once the player is settled", () => {
        const settled = soundStep(SOUND_START, false, { muted: false }).state;
        expect(soundStep(settled, false, { muted: true }).remember).toBe(true);
        expect(soundStep(settled, false, { muted: false }).remember).toBe(false);
        expect(soundStep(settled, false, "playing")).toMatchObject({ ask: false, remember: null });
    });

    it("settles at once when the player already sounds as wanted", () => {
        const step = soundStep(SOUND_START, true, { muted: true });
        expect(step).toMatchObject({ ask: false, remember: null });
        expect(step.state.settled).toBe(true);
    });

    it("asks again when play starts unsettled, and stops asking a player that refuses", () => {
        let state = SOUND_START;
        const asks: boolean[] = [];
        for (const event of [{ muted: true }, "playing", { muted: true }, "playing"] as const) {
            const step = soundStep(state, false, event);
            state = step.state;
            asks.push(step.ask);
            expect(step.remember).toBeNull();
        }
        expect(asks).toEqual([true, true, false, false]);
    });
});
