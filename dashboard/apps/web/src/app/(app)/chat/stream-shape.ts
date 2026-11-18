"use client";

/**
 * The shape of a shared screen when somebody chooses it themselves: a frame
 * rate and a resolution, picked as a mode ("Gaming", "Screenshare") or one by
 * one. Unset, the screen ladder in `call-quality` decides, as it always has.
 *
 * Beside it, the two things about this browser's own share that are only about
 * this screen: whether the sharer sees their own stream, and whether that
 * preview stops while Polaris is not the window in front.
 *
 * Kept per browser, like the quality ladders, and announced in this tab so the
 * picker, the menus and the call all read the same value.
 */

import { z } from "zod";
import { useSyncExternalStore } from "react";
import type { QualityRung } from "./call-quality";

export const STREAM_FRAME_RATES = [15, 30, 60] as const;
export const STREAM_RESOLUTIONS = [480, 720, 1080, 1440, "source"] as const;

/** 5 is the Screenshare mode's own rate: a document, sent sharp and slow. */
export type StreamFrameRate = 5 | (typeof STREAM_FRAME_RATES)[number];
export type StreamResolution = (typeof STREAM_RESOLUTIONS)[number];
export type StreamMode = "gaming" | "screenshare" | "custom";

export interface StreamShape {
    readonly frameRate: StreamFrameRate;
    readonly resolution: StreamResolution;
}

export const STREAM_PRESETS = {
    gaming: { frameRate: 30, resolution: 720 },
    screenshare: { frameRate: 5, resolution: "source" }
} as const satisfies Record<Exclude<StreamMode, "custom">, StreamShape>;

/** Which mode a shape is: a preset when it is exactly one, custom otherwise. */
export function modeOf(shape: StreamShape): StreamMode {
    for (const mode of ["gaming", "screenshare"] as const) {
        const preset = STREAM_PRESETS[mode];
        if (preset.frameRate === shape.frameRate && preset.resolution === shape.resolution) {
            return mode;
        }
    }
    return "custom";
}

/** The long edge of a 16:9 picture at each resolution. */
const LONG_EDGE: Record<Exclude<StreamResolution, "source">, number> = {
    480: 854,
    720: 1280,
    1080: 1920,
    1440: 2560
};

/** What the encoder may spend at 30 frames a second, by resolution. Fewer
 *  frames need less and more need more, within limits - see `streamRung`. */
const BITRATE_AT_30: Record<StreamResolution, number> = {
    480: 1_200_000,
    720: 2_500_000,
    1080: 5_000_000,
    1440: 8_000_000,
    source: 10_000_000
};

/**
 * A chosen shape as a rung of the screen ladder, so everything that opens,
 * encodes and retunes a share reads it the way it reads the ladder's own.
 * "Source" names no size, which is the display's own resolution.
 */
export function streamRung(shape: StreamShape): QualityRung {
    const scale = Math.min(1.5, Math.max(0.3, shape.frameRate / 30));
    const size =
        shape.resolution === "source"
            ? {}
            : { width: LONG_EDGE[shape.resolution], height: shape.resolution };
    return {
        ...size,
        frameRate: shape.frameRate,
        maxBitrate: Math.round(BITRATE_AT_30[shape.resolution] * scale),
        label: "streamQuality.custom",
        detail: `${shape.resolution === "source" ? "Source" : `${shape.resolution}p`}, ${shape.frameRate} fps`
    };
}

export interface StreamPrefs {
    /** Null leaves the screen to the quality ladder. */
    readonly shape: StreamShape | null;
    /** Whether the sharer's own stream is drawn on their screen. */
    readonly showOwn: boolean;
    /** Whether that preview stops while Polaris is not focused. */
    readonly pauseUnfocused: boolean;
}

export const STREAM_PREFS_DEFAULT: StreamPrefs = {
    shape: null,
    showOwn: true,
    pauseUnfocused: false
};

const prefsSchema = z.object({
    shape: z
        .object({
            frameRate: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
            resolution: z.union([
                z.literal(480),
                z.literal(720),
                z.literal(1080),
                z.literal(1440),
                z.literal("source")
            ])
        })
        .nullable()
        .catch(null),
    showOwn: z.boolean().catch(true),
    pauseUnfocused: z.boolean().catch(false)
});

const KEY = "polaris.call.stream";
const CHANGED = "polaris:call-stream";

let cachedRaw: string | null | undefined;
let cached: StreamPrefs = STREAM_PREFS_DEFAULT;

/** What this browser keeps. Anything unreadable is the default: local storage
 *  belongs to whoever owns the browser, and nothing in it reaches a constraint
 *  without being checked. */
export function streamPrefs(): StreamPrefs {
    if (typeof window === "undefined") return STREAM_PREFS_DEFAULT;
    let raw: string | null;
    try {
        raw = window.localStorage.getItem(KEY);
    } catch {
        // No storage here: what this tab was told is all there is.
        return cached;
    }
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    if (!raw) {
        cached = STREAM_PREFS_DEFAULT;
        return cached;
    }
    try {
        const parsed = prefsSchema.safeParse(JSON.parse(raw));
        cached = parsed.success ? parsed.data : STREAM_PREFS_DEFAULT;
    } catch {
        cached = STREAM_PREFS_DEFAULT;
    }
    return cached;
}

/** Change some of them. Applies to this tab at once even when it cannot be
 *  remembered. */
export function setStreamPrefs(change: Partial<StreamPrefs>): void {
    if (typeof window === "undefined") return;
    const next = { ...streamPrefs(), ...change };
    const raw = JSON.stringify(next);
    try {
        window.localStorage.setItem(KEY, raw);
    } catch {
        // Kept for this tab only.
    }
    cachedRaw = raw;
    cached = next;
    window.dispatchEvent(new Event(CHANGED));
}

/** The shape in force, or null for the quality ladder. */
export function streamShape(): StreamShape | null {
    return streamPrefs().shape;
}

function subscribe(listener: () => void): () => void {
    window.addEventListener(CHANGED, listener);
    window.addEventListener("storage", listener);
    return () => {
        window.removeEventListener(CHANGED, listener);
        window.removeEventListener("storage", listener);
    };
}

export function useStreamPrefs(): StreamPrefs {
    return useSyncExternalStore(subscribe, streamPrefs, () => STREAM_PREFS_DEFAULT);
}
