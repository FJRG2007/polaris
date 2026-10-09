/**
 * The seasonal sound packs: every sound recast for the season, held to the
 * limits the ordinary ones meet.
 *
 * What a person depends on: the season's ring is still a ring - as loud, as
 * long, two pulses and done before it repeats - so a call is not missed because
 * it is Halloween; the sounds a call is followed by change colour but not shape
 * or loudness; and the ordinary sounds come back the moment the season or the
 * pack ends.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SEASONS } from "@polaris/core";
import { peakLevel, passLength } from "./sound-peak";
import { setSoundSeason } from "@/lib/sound-season";
import { CHIME, chimeFor, SEASONAL_CHIMES } from "@/lib/notification-sound";
import {
    DEFAULT_GAIN,
    notesFor,
    RECAST,
    RING_EVERY_MS,
    SEASONAL_SOUNDS,
    SOUNDS
} from "@/lib/call-sounds";

afterEach(() => setSoundSeason(null));

describe.each(SEASONS)("the %s pack", (season) => {
    const ring = SEASONAL_SOUNDS[season].ring ?? [];

    it("rings as loud as the ordinary ring, and no louder", () => {
        for (const note of ring) expect(note.gain).toBe(SOUNDS.ring[0]?.gain);
        expect(peakLevel(ring) * 2).toBeLessThan(1);
    });

    it("is a ring: bells, two pulses, finished before it starts again", () => {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring.every((note) => note.bell && !note.sustain)).toBe(true);
        expect(passLength(ring)).toBeLessThan(RING_EVERY_MS.ring / 1000);
    });

    it("keeps its message blip as quiet as the ordinary one", () => {
        const message = SEASONAL_SOUNDS[season].message ?? [];
        expect(message.length).toBeGreaterThan(1);
        for (const note of message)
            expect(note.gain ?? DEFAULT_GAIN).toBeLessThanOrEqual(DEFAULT_GAIN);
    });

    it("recasts every sound, and only in pitch and touch", () => {
        expect(Object.keys(SEASONAL_SOUNDS[season]).sort()).toEqual(
            Object.keys(SOUNDS)
                .filter((name) => name !== "ringBack")
                .sort()
        );
        for (const name of RECAST) {
            const plain = SOUNDS[name];
            const recast = SEASONAL_SOUNDS[season][name] ?? [];
            expect(
                recast.map(({ at, seconds, gain, wave }) => ({ at, seconds, gain, wave }))
            ).toEqual(plain.map(({ at, seconds, gain, wave }) => ({ at, seconds, gain, wave })));
            expect(peakLevel(recast)).toBeLessThan(0.5);
        }
    });

    it("has a chime no longer than the ordinary one by much", () => {
        const end = (notes: readonly (readonly [number, number, number])[]) =>
            notes.reduce((last, [, at, seconds]) => Math.max(last, at + seconds), 0);
        expect(end(SEASONAL_CHIMES[season])).toBeLessThanOrEqual(end(CHIME) + 0.05);
    });

    it("announces news rising, never falling like a hang-up", () => {
        const chime = SEASONAL_CHIMES[season];
        expect(chime.at(-1)![0]).toBeGreaterThan(chime[0]![0]);
        const message = SEASONAL_SOUNDS[season].message ?? [];
        expect(message.at(-1)!.from).toBeGreaterThan(message[0]!.from);
    });
});

describe("which sounds play", () => {
    it("is the ordinary set until a season is chosen", () => {
        expect(notesFor("ring")).toBe(SOUNDS.ring);
        expect(chimeFor()).toBe(CHIME);
    });

    it("is the season's while one is in force", () => {
        setSoundSeason("winter");
        expect(notesFor("ring")).toBe(SEASONAL_SOUNDS.winter.ring);
        expect(notesFor("hangUp")).toBe(SEASONAL_SOUNDS.winter.hangUp);
        expect(notesFor("ringBack")).toBe(SOUNDS.ringBack);
        expect(chimeFor()).toBe(SEASONAL_CHIMES.winter);
        setSoundSeason(null);
        expect(notesFor("ring")).toBe(SOUNDS.ring);
    });
});
