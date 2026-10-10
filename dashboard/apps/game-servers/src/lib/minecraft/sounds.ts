/**
 * A Minecraft server's own sounds: what an uploaded file has to be, what the
 * library and its settings look like, and the resource pack built from them.
 *
 * The game plays one audio format, Ogg Vorbis, mono or stereo. Anything else an
 * operator picks (MP3, WAV, M4A, FLAC) is decoded and re-encoded by the browser
 * before it is sent (`sound-encode.ts`), so what reaches the server is always an
 * Ogg file - and the server checks that it really is one (`readVorbis`) rather
 * than trusting the browser that sent it.
 *
 * The pack holds every sound under the `polaris` namespace: an upload named
 * "Victory fanfare" is `polaris:victory_fanfare`, played with `playsound` like
 * any of the game's own. A sound can also stand in for one of the game's (a
 * music disc, the menu music): the pack then points that sound at the upload.
 *
 * Pure and free of Node, so the screen checks a file with exactly the rules the
 * server applies.
 */

import { z } from "zod";

/** The switch that keeps the Polaris plugin on a plugin server for its sounds.
 *  The NeoForge mod is always there and needs none. */
export const SOUNDS_KEY = "POLARIS_SOUNDS";

/** The tag the mod and the plugin put on a player whose game has loaded the
 *  pack, and take off when it has not. A custom sound is only played to them;
 *  everybody else hears the game's own. Kept in step with both. */
export const SOUND_TAG = "polaris_sounds";

/** The namespace every uploaded sound is played under. */
export const NAMESPACE = "polaris";

/** One sound's largest file: about eight minutes of music at the encoder's
 *  default quality. */
export const MAX_SOUND_BYTES = 8 * 1024 * 1024;
/** Every sound of one server together. The game itself refuses a pack past
 *  250 MB; players download this one on join, so it stays far below. */
export const MAX_LIBRARY_BYTES = 48 * 1024 * 1024;
export const MAX_SOUNDS = 100;
/** Past this a sound is streamed from disk rather than held in memory, which is
 *  what the game wants for music. */
export const STREAM_AFTER_SECONDS = 12;
export const MAX_NAME = 48;
export const MAX_KEY = 40;
export const MAX_SUBTITLE = 80;
export const MAX_PROMPT = 160;
export const MAX_PLAYER_SOUNDS = 200;

/** The extensions the picker offers. What a browser can decode is wider, and
 *  the decoder is the real test. */
export const ACCEPTED_FILES = ".ogg,.oga,.mp3,.wav,.m4a,.aac,.flac,.opus,.webm,audio/*";

// ------------------------------------------------------------------ names

/** A name as it is shown: spaces collapsed and trimmed. */
export function normalizeSoundName(name: string): string {
    return name.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * The key a sound is played by, from its name: lowercase ASCII letters, digits
 * and underscores, which every release accepts in a sound's id. Accents are
 * folded ("Canción" -> "cancion"); anything else becomes an underscore. Empty
 * when nothing usable is left.
 */
export function soundKey(name: string): string {
    return normalizeSoundName(name)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, MAX_KEY)
        .replace(/_+$/, "");
}

/** A key that is free among `taken`: the key itself, or it with a number. */
export function freeKey(key: string, taken: ReadonlySet<string>): string {
    if (!taken.has(key)) return key;
    for (let n = 2; ; n++) {
        const suffix = `_${n}`;
        const candidate = `${key.slice(0, MAX_KEY - suffix.length)}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}

export const soundNameSchema = z
    .string()
    .transform(normalizeSoundName)
    .pipe(z.string().min(1).max(MAX_NAME))
    .refine((name) => soundKey(name).length > 0, { message: "noKey" });

/** One of the game's sounds, as a pack replaces it: `minecraft:` and a path. */
const VANILLA_ID = /^(minecraft:)?[a-z0-9_.-]{1,120}$/;

export function normalizeVanillaId(id: string): string {
    const trimmed = id.trim().toLowerCase();
    if (!trimmed) return "";
    return trimmed.startsWith("minecraft:") ? trimmed : `minecraft:${trimmed}`;
}

export const vanillaIdSchema = z
    .string()
    .transform(normalizeVanillaId)
    .refine((id) => id === "" || VANILLA_ID.test(id), { message: "badVanilla" });

// ------------------------------------------------------------------ Ogg Vorbis

export type VorbisRefusal =
    /** Not an Ogg file at all. */
    | "notOgg"
    /** An Ogg file holding Opus, which the game cannot play. */
    | "opus"
    /** An Ogg file holding something else. */
    | "notVorbis"
    /** More than two channels. */
    | "channels"
    /** Cut short, or a page whose checksum is wrong. */
    | "broken"
    /** More than one stream in one file. */
    | "chained";

export type VorbisInfo =
    | {
          readonly ok: true;
          readonly channels: 1 | 2;
          readonly sampleRate: number;
          readonly seconds: number;
      }
    | { readonly ok: false; readonly reason: VorbisRefusal };

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
        table[i] = r >>> 0;
    }
    return table;
})();

/** Ogg's own checksum: CRC-32, polynomial 0x04c11db7, not reflected, over the
 *  page with its checksum field read as zero. */
function pageCrc(bytes: Uint8Array, start: number, end: number): number {
    let crc = 0;
    for (let at = start; at < end; at++) {
        const byte = at - start >= 22 && at - start < 26 ? 0 : (bytes[at] as number);
        crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0;
    }
    return crc;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
    let text = "";
    for (let i = 0; i < length && at + i < bytes.length; i++)
        text += String.fromCharCode(bytes[at + i] as number);
    return text;
}

/**
 * What an Ogg Vorbis file holds, read page by page from its own structure: every
 * page's capture pattern, length and checksum, one logical stream from start to
 * end, and a Vorbis identification header with one or two channels. Its length
 * is the last page's sample position over the sample rate.
 */
export function readVorbis(bytes: Uint8Array): VorbisInfo {
    if (bytes.length < 58 || ascii(bytes, 0, 4) !== "OggS") return { ok: false, reason: "notOgg" };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    let serial: number | null = null;
    let channels = 0;
    let sampleRate = 0;
    let granule = 0;
    let pages = 0;
    let ended = false;
    while (at < bytes.length) {
        if (ended) return { ok: false, reason: "chained" };
        if (at + 27 > bytes.length || ascii(bytes, at, 4) !== "OggS" || bytes[at + 4] !== 0)
            return { ok: false, reason: pages === 0 ? "notOgg" : "broken" };
        const flags = bytes[at + 5] as number;
        const segments = bytes[at + 26] as number;
        const headerEnd = at + 27 + segments;
        if (headerEnd > bytes.length) return { ok: false, reason: "broken" };
        let bodyLength = 0;
        for (let i = 0; i < segments; i++) bodyLength += bytes[at + 27 + i] as number;
        const end = headerEnd + bodyLength;
        if (end > bytes.length) return { ok: false, reason: "broken" };
        if (pageCrc(bytes, at, end) !== view.getUint32(at + 22, true))
            return { ok: false, reason: "broken" };
        const pageSerial = view.getUint32(at + 14, true);
        if (pages === 0) {
            if (!(flags & 0x02)) return { ok: false, reason: "notOgg" };
            serial = pageSerial;
            if (ascii(bytes, headerEnd, 8) === "OpusHead") return { ok: false, reason: "opus" };
            if (
                bytes[headerEnd] !== 1 ||
                ascii(bytes, headerEnd + 1, 6) !== "vorbis" ||
                bodyLength < 30
            )
                return { ok: false, reason: "notVorbis" };
            if (view.getUint32(headerEnd + 7, true) !== 0)
                return { ok: false, reason: "notVorbis" };
            channels = bytes[headerEnd + 11] as number;
            sampleRate = view.getUint32(headerEnd + 12, true);
            if (channels !== 1 && channels !== 2) return { ok: false, reason: "channels" };
            if (sampleRate < 8000 || sampleRate > 192000) return { ok: false, reason: "notVorbis" };
        } else if (pageSerial !== serial) {
            return { ok: false, reason: "chained" };
        }
        // -1 marks a page on which no packet ends.
        const low = view.getUint32(at + 6, true);
        const high = view.getInt32(at + 10, true);
        if (!(high === -1 && low === 0xffffffff)) granule = Math.max(granule, high * 2 ** 32 + low);
        if (flags & 0x04) ended = true;
        pages += 1;
        at = end;
    }
    if (pages < 2) return { ok: false, reason: "broken" };
    return {
        ok: true,
        channels: channels as 1 | 2,
        sampleRate,
        seconds: Math.round((granule / sampleRate) * 100) / 100
    };
}

// ------------------------------------------------------------------ settings

/** The moments of an event a sound can be put on, by the sound each one plays
 *  today (`SOUNDS` in `events/commands.ts`). */
export const EVENT_MOMENTS = ["countdown", "start", "win", "horn", "boss"] as const;
/** The moments the mod and the plugin play on their own. */
export const SERVER_MOMENTS = ["join", "welcome"] as const;
export const MOMENTS = [...EVENT_MOMENTS, ...SERVER_MOMENTS] as const;
export type Moment = (typeof MOMENTS)[number];

export const MIN_PITCH = 0.5;
export const MAX_PITCH = 2;

const level = z.number().finite().min(0).max(1).catch(1);
const pitch = z.number().finite().min(MIN_PITCH).max(MAX_PITCH).catch(1);

export const soundUseSchema = z.object({
    sound: z.string().regex(/^[a-z0-9_]{1,40}$/),
    volume: level,
    pitch
});

export type SoundUse = z.infer<typeof soundUseSchema>;

const PLAYER = /^[A-Za-z0-9_]{1,16}$/;

export const playerSoundSchema = soundUseSchema.extend({
    player: z.string().trim().regex(PLAYER)
});

export type PlayerSound = z.infer<typeof playerSoundSchema>;

/** What the server does with its sounds, as stored. Read whole and forgiving:
 *  a row written by an older screen, or a field a newer one dropped, falls back
 *  to its default rather than failing the read. */
export const soundSettingsSchema = z.object({
    /** Whether a player who turns the pack down is sent away. */
    required: z.boolean().catch(false),
    /** The line the game shows when it asks; empty for its own. */
    prompt: z.string().max(MAX_PROMPT).catch(""),
    moments: z
        .record(z.string(), z.unknown())
        .catch({})
        .transform((raw) => {
            const kept: Partial<Record<Moment, SoundUse>> = {};
            for (const moment of MOMENTS) {
                const parsed = soundUseSchema.safeParse(raw[moment]);
                if (parsed.success) kept[moment] = parsed.data;
            }
            return kept;
        }),
    players: z
        .array(z.unknown())
        .catch([])
        .transform((raw) =>
            raw
                .map((one) => playerSoundSchema.safeParse(one))
                .flatMap((one) => (one.success ? [one.data] : []))
                .slice(0, MAX_PLAYER_SOUNDS)
        )
});

export type SoundSettings = z.infer<typeof soundSettingsSchema>;

export const DEFAULT_SETTINGS: SoundSettings = {
    required: false,
    prompt: "",
    moments: {},
    players: []
};

/** Stored settings, whatever shape they were stored in. */
export function readSoundSettings(json: string | null | undefined): SoundSettings {
    if (!json) return DEFAULT_SETTINGS;
    try {
        const parsed = soundSettingsSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : DEFAULT_SETTINGS;
    } catch {
        return DEFAULT_SETTINGS;
    }
}

/** The same settings without anything that points at a sound no longer there. */
export function withoutMissing(settings: SoundSettings, keys: ReadonlySet<string>): SoundSettings {
    const moments: Partial<Record<Moment, SoundUse>> = {};
    for (const [moment, use] of Object.entries(settings.moments) as [Moment, SoundUse][])
        if (keys.has(use.sound)) moments[moment] = use;
    return {
        ...settings,
        moments,
        players: settings.players.filter((one) => keys.has(one.sound))
    };
}

// ------------------------------------------------------------------ pack

/** One sound as the pack carries it. */
export interface PackSound {
    readonly key: string;
    readonly subtitle: string;
    readonly stream: boolean;
    /** One of the game's sounds this one plays instead of, or empty. */
    readonly replaces: string;
}

export const PACK_DESCRIPTION = "Polaris";

/** The pack's description and the releases it says it is for. A pack that only
 *  holds sounds reads the same on every release that takes a pushed pack
 *  (1.20.3 on), so the range is open-ended: the format number only decides
 *  whether the game warns about it. */
export function packMeta(description: string): string {
    return `${JSON.stringify(
        {
            pack: {
                description,
                pack_format: 46,
                supported_formats: { min_inclusive: 22, max_inclusive: 999 },
                min_format: 22,
                max_format: 999
            }
        },
        null,
        2
    )}\n`;
}

/** The pack's `assets/polaris/sounds.json`: one sound event per upload. */
export function soundsJson(sounds: readonly PackSound[]): string {
    const events: Record<string, unknown> = {};
    for (const sound of [...sounds].sort((a, b) => a.key.localeCompare(b.key))) {
        events[sound.key] = {
            sounds: [{ name: `${NAMESPACE}:${sound.key}`, stream: sound.stream }],
            ...(sound.subtitle ? { subtitle: `${NAMESPACE}.subtitle.${sound.key}` } : {})
        };
    }
    return `${JSON.stringify(events, null, 2)}\n`;
}

/** The game's own sounds the pack replaces, as `assets/minecraft/sounds.json`,
 *  or null when it replaces none. Two uploads for the same sound play at random,
 *  as the game does with its own variants. */
export function replacedJson(sounds: readonly PackSound[]): string | null {
    const events: Record<string, { replace: true; sounds: { name: string; stream: boolean }[] }> =
        {};
    for (const sound of [...sounds].sort((a, b) => a.key.localeCompare(b.key))) {
        if (!sound.replaces) continue;
        const id = sound.replaces.slice("minecraft:".length);
        const entry = (events[id] ??= { replace: true, sounds: [] });
        entry.sounds.push({ name: `${NAMESPACE}:${sound.key}`, stream: sound.stream });
    }
    return Object.keys(events).length > 0 ? `${JSON.stringify(events, null, 2)}\n` : null;
}

/** The subtitles, as the pack's English language file: shown to players who
 *  turned subtitles on, in every language (the game falls back to English). */
export function subtitlesJson(sounds: readonly PackSound[]): string | null {
    const lines: Record<string, string> = {};
    for (const sound of [...sounds].sort((a, b) => a.key.localeCompare(b.key)))
        if (sound.subtitle) lines[`${NAMESPACE}.subtitle.${sound.key}`] = sound.subtitle;
    return Object.keys(lines).length > 0 ? `${JSON.stringify(lines, null, 2)}\n` : null;
}

/** Where a sound's file sits in the pack. */
export function soundPath(key: string): string {
    return `assets/${NAMESPACE}/sounds/${key}.ogg`;
}

/** The id `playsound` takes for one upload. */
export function soundId(key: string): string {
    return `${NAMESPACE}:${key}`;
}

/** A level or a pitch as a command takes it: at most two decimals. */
export function commandNumber(value: number): string {
    return String(Math.round(value * 100) / 100);
}
