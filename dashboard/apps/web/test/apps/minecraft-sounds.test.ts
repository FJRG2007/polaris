/**
 * A server's own sounds: what an uploaded file has to be, the pack built from
 * the library, and an event's sound replaced by the server's own.
 *
 * The file check is exercised against the real encoder the Sounds tab converts
 * with (libvorbis compiled to WebAssembly), not against a hand-made header: the
 * one thing it must never do is refuse what that encoder wrote, or accept what
 * the game cannot play.
 */

import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
    DEFAULT_SETTINGS,
    freeKey,
    packMeta,
    readSoundSettings,
    readVorbis,
    replacedJson,
    soundKey,
    soundNameSchema,
    soundsJson,
    subtitlesJson,
    vanillaIdSchema,
    withoutMissing
} from "@polaris-app/game-servers/src/lib/minecraft/sounds";
import { encodePcm } from "@polaris-app/game-servers/src/lib/minecraft/sound-encode";
import { hiddenFromPending } from "@polaris-app/game-servers/src/lib/minecraft/prelogin";
import { SOUNDS, sound } from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import { MOMENT_SOUNDS, momentOverrides, withMoments } from "@polaris-app/game-servers/src/lib/minecraft/sound-moments";

const require = createRequire(import.meta.url);
const WASM = new Uint8Array(readFileSync(require.resolve("wasm-media-encoders/wasm/ogg.wasm")));

function tone(seconds: number, rate: number, channels: number): Float32Array[] {
    return Array.from({ length: channels }, (_, channel) => {
        const samples = new Float32Array(Math.round(seconds * rate));
        for (let at = 0; at < samples.length; at++)
            samples[at] = 0.3 * Math.sin((2 * Math.PI * (440 + channel * 110) * at) / rate);
        return samples;
    });
}

describe("readVorbis", () => {
    it("reads what the encoder writes: channels, rate and length", async () => {
        const mono = await encodePcm(tone(1.5, 44_100, 1), 44_100, 4, WASM);
        expect(readVorbis(mono)).toEqual({ ok: true, channels: 1, sampleRate: 44_100, seconds: 1.5 });
        const stereo = await encodePcm(tone(0.5, 48_000, 2), 48_000, -1, WASM);
        expect(readVorbis(stereo)).toEqual({ ok: true, channels: 2, sampleRate: 48_000, seconds: 0.5 });
    });

    it("refuses a file cut short or with a changed byte", async () => {
        const file = await encodePcm(tone(1, 44_100, 1), 44_100, 4, WASM);
        expect(readVorbis(file.slice(0, file.length - 10))).toEqual({ ok: false, reason: "broken" });
        const flipped = file.slice();
        const middle = Math.floor(file.length / 2);
        flipped[middle] = flipped[middle]! ^ 0xff;
        expect(readVorbis(flipped)).toEqual({ ok: false, reason: "broken" });
    });

    it("refuses two files glued together", async () => {
        const one = await encodePcm(tone(0.3, 44_100, 1), 44_100, 4, WASM);
        const glued = new Uint8Array(one.length * 2);
        glued.set(one, 0);
        glued.set(one, one.length);
        expect(readVorbis(glued)).toEqual({ ok: false, reason: "chained" });
    });

    it("refuses what is not Ogg Vorbis, naming Opus", () => {
        expect(readVorbis(new TextEncoder().encode("ID3".padEnd(100, "x")))).toEqual({ ok: false, reason: "notOgg" });
        expect(readVorbis(new Uint8Array(0))).toEqual({ ok: false, reason: "notOgg" });
        const opus = oggPage(new TextEncoder().encode("OpusHead".padEnd(19, "\0")));
        expect(readVorbis(opus)).toEqual({ ok: false, reason: "opus" });
    });
});

/** One Ogg page holding `body`, with a correct checksum. */
function oggPage(body: Uint8Array): Uint8Array {
    const header = new Uint8Array(27 + 1);
    header.set([0x4f, 0x67, 0x67, 0x53, 0, 0x02]);
    header[26] = 1;
    header[27] = body.length;
    const page = new Uint8Array(header.length + body.length + 40);
    page.set(header);
    page.set(body, header.length);
    let crc = 0;
    for (const byte of page.subarray(0, header.length + body.length)) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
        crc >>>= 0;
    }
    new DataView(page.buffer).setUint32(22, crc, true);
    return page;
}

describe("names", () => {
    it("makes a key the game takes from any name", () => {
        expect(soundKey("Victory Fanfare!")).toBe("victory_fanfare");
        expect(soundKey("  Canción   del  Jefe ")).toBe("cancion_del_jefe");
        expect(soundKey("***")).toBe("");
        expect(soundKey("a".repeat(80))).toHaveLength(40);
    });

    it("numbers a key that is taken", () => {
        expect(freeKey("horn", new Set(["horn", "horn_2"]))).toBe("horn_3");
        expect(freeKey("horn", new Set())).toBe("horn");
    });

    it("refuses a name with nothing usable in it", () => {
        expect(soundNameSchema.safeParse("   ").success).toBe(false);
        expect(soundNameSchema.safeParse("!!!").success).toBe(false);
        expect(soundNameSchema.parse("  Boss   theme ")).toBe("Boss theme");
    });

    it("reads a game sound to replace with or without its namespace", () => {
        expect(vanillaIdSchema.parse("music_disc.cat")).toBe("minecraft:music_disc.cat");
        expect(vanillaIdSchema.parse(" MINECRAFT:music.menu ")).toBe("minecraft:music.menu");
        expect(vanillaIdSchema.parse("")).toBe("");
        expect(vanillaIdSchema.safeParse("minecraft:../../x").success).toBe(false);
    });
});

describe("settings", () => {
    it("reads an old or broken row as the defaults, field by field", () => {
        expect(readSoundSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(readSoundSettings("not json")).toEqual(DEFAULT_SETTINGS);
        const read = readSoundSettings(
            JSON.stringify({
                required: "yes",
                moments: { win: { sound: "fanfare", volume: 7, pitch: 1.2 }, nope: { sound: "x" }, start: { sound: "BAD KEY" } },
                players: [{ player: "Ana", sound: "ana", volume: 0.5, pitch: 1 }, { player: "two words", sound: "x" }]
            })
        );
        expect(read.required).toBe(false);
        expect(read.moments).toEqual({ win: { sound: "fanfare", volume: 1, pitch: 1.2 } });
        expect(read.players).toEqual([{ player: "Ana", sound: "ana", volume: 0.5, pitch: 1 }]);
    });

    it("drops whatever points at a deleted sound", () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            moments: { win: { sound: "gone", volume: 1, pitch: 1 }, start: { sound: "kept", volume: 1, pitch: 1 } },
            players: [{ player: "Ana", sound: "gone", volume: 1, pitch: 1 }]
        };
        const kept = withoutMissing(settings, new Set(["kept"]));
        expect(kept.moments).toEqual({ start: { sound: "kept", volume: 1, pitch: 1 } });
        expect(kept.players).toEqual([]);
    });
});

describe("the pack", () => {
    const sounds = [
        { key: "fanfare", subtitle: "Fanfare plays", stream: false, replaces: "" },
        { key: "theme", subtitle: "", stream: true, replaces: "minecraft:music_disc.cat" },
        { key: "theme_2", subtitle: "", stream: true, replaces: "minecraft:music_disc.cat" }
    ];

    it("names every sound under polaris, streaming music", () => {
        expect(JSON.parse(soundsJson(sounds))).toEqual({
            fanfare: { sounds: [{ name: "polaris:fanfare", stream: false }], subtitle: "polaris.subtitle.fanfare" },
            theme: { sounds: [{ name: "polaris:theme", stream: true }] },
            theme_2: { sounds: [{ name: "polaris:theme_2", stream: true }] }
        });
        expect(JSON.parse(subtitlesJson(sounds)!)).toEqual({ "polaris.subtitle.fanfare": "Fanfare plays" });
    });

    it("replaces a game sound with every upload put on it", () => {
        expect(JSON.parse(replacedJson(sounds)!)).toEqual({
            "music_disc.cat": {
                replace: true,
                sounds: [
                    { name: "polaris:theme", stream: true },
                    { name: "polaris:theme_2", stream: true }
                ]
            }
        });
        expect(replacedJson([sounds[0]!])).toBeNull();
    });

    it("says it is a pack for 1.20.3 on", () => {
        const meta = JSON.parse(packMeta("Sounds")).pack;
        expect(meta.pack_format).toBeGreaterThanOrEqual(22);
        expect(meta.supported_formats.min_inclusive).toBeLessThanOrEqual(22);
        expect(meta.min_format).toBeLessThanOrEqual(22);
    });

    it("is a zip the same bytes every time", async () => {
        const make = async () => {
            const zip = new JSZip();
            const date = new Date("2000-01-01T00:00:00Z");
            zip.file("pack.mcmeta", packMeta("x"), { date, compression: "STORE" });
            zip.file("assets/polaris/sounds.json", soundsJson(sounds), { date, compression: "STORE" });
            return zip.generateAsync({ type: "uint8array", platform: "UNIX" });
        };
        expect(Buffer.from(await make()).equals(Buffer.from(await make()))).toBe(true);
    });
});

describe("event moments", () => {
    const overrides = momentOverrides(
        { win: { sound: "fanfare", volume: 0.5, pitch: 1.5 }, start: { sound: "gone", volume: 1, pitch: 1 } },
        new Set(["fanfare"])
    );

    it("covers every sound an event plays at a moment", () => {
        expect(Object.values(MOMENT_SOUNDS).sort()).toEqual(Object.values(SOUNDS).sort());
    });

    it("plays the server's sound to players with the pack and the game's to the rest", () => {
        expect(withMoments(sound(SOUNDS.win), overrides)).toEqual([
            "execute as @a at @s if entity @s[tag=polaris_sounds] run playsound polaris:fanfare master @s ~ ~ ~ 0.5 1.5",
            `execute as @a at @s unless entity @s[tag=polaris_sounds] run playsound ${SOUNDS.win} master @s ~ ~ ~ 1 1`
        ]);
    });

    it("leaves a moment whose sound is gone, an unmarked line and other sounds alone", () => {
        expect(withMoments(sound(SOUNDS.start), overrides)).toEqual([sound(SOUNDS.start)]);
        const announcement = `execute as @a at @s run playsound ${SOUNDS.win} master @s ~ ~ ~ 1 1`;
        expect(withMoments(announcement, overrides)).toEqual([announcement]);
        expect(withMoments(sound(SOUNDS.tick), overrides)).toEqual([sound(SOUNDS.tick)]);
    });

    it("is not rewritten twice, and still keeps held players out", () => {
        const [custom, vanilla] = withMoments(
            `execute in minecraft:overworld as @a[tag=pe_in] at @s run playsound ${SOUNDS.win} master @s ~ ~ ~ 1 1 0`,
            overrides
        ) as [string, string];
        expect(withMoments(vanilla, overrides)).toEqual([vanilla]);
        expect(hiddenFromPending(custom)).toBe(
            "execute in minecraft:overworld as @a[tag=pe_in,tag=!polaris_pending] at @s if entity @s[tag=polaris_sounds] run playsound polaris:fanfare master @s ~ ~ ~ 0.5 1.5"
        );
    });
});
