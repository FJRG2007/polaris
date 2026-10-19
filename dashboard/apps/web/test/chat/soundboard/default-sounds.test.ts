/**
 * The sounds every call has.
 *
 * Each is a real recording Polaris ships in `public/sounds/soundboard`, so
 * each id needs its file there, a file the same rules as an upload accept, and
 * a line in `sources.json` saying where it came from under a licence that lets
 * an AGPL project redistribute it without owing anybody anything.
 */

import { describe, expect, it } from "vitest";
import { readWav } from "@/lib/chat/sound-file";
import { readdirSync, readFileSync } from "node:fs";
import { DEFAULT_SOUND_IDS, defaultSoundUrl } from "@/lib/chat/soundboard";

const PUBLIC = new URL("../../../public/", import.meta.url);
const FOLDER = new URL("sounds/soundboard/", PUBLIC);

/** Licences whose terms ask for nothing: no attribution, no share-alike. */
const FREE = new Set(["CC0-1.0", "public-domain"]);

const manifest = JSON.parse(readFileSync(new URL("sources.json", FOLDER), "utf8")) as {
    sounds: Record<string, { source: string; license: string; licenseUrl: string }>;
};

const fileOf = (id: (typeof DEFAULT_SOUND_IDS)[number]) =>
    new Uint8Array(readFileSync(new URL(defaultSoundUrl(id).slice(1), PUBLIC)));

/** RMS level in dBFS over 50 ms blocks, ignoring blocks 30 dB under the
 *  loudest - how the files were levelled. */
function gatedLevel(wav: Uint8Array): number {
    const view = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44);
    const rate = new DataView(wav.buffer, wav.byteOffset).getUint32(24, true);
    const block = Math.floor(rate / 20);
    const levels: number[] = [];
    for (let at = 0; at + block <= view.byteLength / 2; at += block) {
        let sum = 0;
        for (let index = at; index < at + block; index += 1) {
            const sample = view.getInt16(index * 2, true) / 32_768;
            sum += sample * sample;
        }
        levels.push(sum / block);
    }
    const loudest = Math.max(...levels);
    const kept = levels.filter((level) => level > loudest * 1e-3);
    return 10 * Math.log10(kept.reduce((total, level) => total + level, 0) / kept.length);
}

describe("the default sounds", () => {
    it.each(DEFAULT_SOUND_IDS)("%s has a file an upload would be accepted as", (id) => {
        const file = readWav(fileOf(id));
        expect(file.ok).toBe(true);
        if (file.ok) {
            expect(file.channels).toBe(1);
            expect(file.durationMs).toBeGreaterThan(500);
        }
    });

    it.each(DEFAULT_SOUND_IDS)("%s says where it came from, under a free licence", (id) => {
        const entry = manifest.sounds[id];
        expect(entry).toBeDefined();
        expect(FREE.has(entry?.license ?? "")).toBe(true);
        // A recording names where it was published; the one Polaris made itself
        // names the script that makes it, in this repository.
        expect(entry?.source).toMatch(
            /^https:\/\/(freesound\.org|commons\.wikimedia\.org|github\.com\/FJRG2007\/polaris\/blob\/main\/dashboard\/apps\/web\/scripts\/)/
        );
    });

    it("ships nothing that is not one of them", () => {
        const ids: readonly string[] = DEFAULT_SOUND_IDS;
        const files = readdirSync(FOLDER).filter((name) => name !== "sources.json");
        expect(files.sort()).toEqual(ids.map((id) => `${id}.wav`).sort());
        expect(Object.keys(manifest.sounds).sort()).toEqual([...ids].sort());
    });

    it("are about as loud as each other", () => {
        const levels = DEFAULT_SOUND_IDS.map((id) => gatedLevel(fileOf(id)));
        expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(2);
    });
});
