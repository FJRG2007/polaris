"use client";

/**
 * How the soundboard sounds to this listener: how loud, whose sounds never at
 * all, and what they played last.
 *
 * Kept in this browser, like every other volume in a call (`call-volumes`),
 * because they are facts about a machine in a room: the laptop with the
 * speakers and the desk with the headset want different volumes. They apply to
 * nobody else - muting somebody's sounds here mutes them for this listener
 * only, and the person playing them is not told.
 *
 * Under the `polaris.` prefix, so the button that empties this browser clears
 * them with everything else.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.chat.soundboard";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:soundboard-prefs";

/** How many recently played sounds are remembered: one row of the picker. */
const RECENT = 8;

/** The most people anybody mutes; a bound so the record cannot grow forever. */
const MUTED_MAX = 500;

export interface SoundboardPrefs {
    /** Every sound's loudness, 0 to 1, on top of its own. Zero is silence, and
     *  the cue over the player's face still appears - Discord's rule too. */
    readonly volume: number;
    /** Accounts whose sounds this listener never hears. */
    readonly muted: readonly string[];
    /** What this listener played last, newest first, by reference. */
    readonly recent: readonly string[];
}

export const SOUNDBOARD_DEFAULTS: SoundboardPrefs = { volume: 1, muted: [], recent: [] };

function strings(value: unknown, max: number): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((entry): entry is string => typeof entry === "string" && entry.length <= 64)
        .slice(0, max);
}

export function soundboardPrefs(): SoundboardPrefs {
    if (typeof window === "undefined") return SOUNDBOARD_DEFAULTS;
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return SOUNDBOARD_DEFAULTS;
        const held = JSON.parse(raw) as Partial<Record<keyof SoundboardPrefs, unknown>>;
        const volume = Number(held.volume);
        return {
            volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1,
            muted: strings(held.muted, MUTED_MAX),
            recent: strings(held.recent, RECENT)
        };
    } catch {
        return SOUNDBOARD_DEFAULTS;
    }
}

function write(next: SoundboardPrefs): SoundboardPrefs {
    if (typeof window !== "undefined") {
        try {
            window.localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
            // Applies to what is open now; it just will not be remembered.
        }
        window.dispatchEvent(new Event(CHANGED));
    }
    return next;
}

export function setSoundboardVolume(volume: number): SoundboardPrefs {
    return write({ ...soundboardPrefs(), volume: Math.min(1, Math.max(0, volume)) });
}

export function setSoundboardMuted(userId: string, muted: boolean): SoundboardPrefs {
    const prefs = soundboardPrefs();
    const others = prefs.muted.filter((id) => id !== userId);
    return write({ ...prefs, muted: muted ? [userId, ...others].slice(0, MUTED_MAX) : others });
}

/** Remember a sound this listener just played. */
export function rememberPlayed(ref: string): SoundboardPrefs {
    const prefs = soundboardPrefs();
    return write({
        ...prefs,
        recent: [ref, ...prefs.recent.filter((entry) => entry !== ref)].slice(0, RECENT)
    });
}

/** The preferences, followed across this browser's tabs. */
export function useSoundboardPrefs(): SoundboardPrefs {
    // Never read during render: the server has no local storage, and a value
    // that differed between the two would fail hydration.
    const [prefs, setPrefs] = useState<SoundboardPrefs>(SOUNDBOARD_DEFAULTS);
    useEffect(() => {
        const read = () => setPrefs(soundboardPrefs());
        read();
        window.addEventListener(CHANGED, read);
        window.addEventListener("storage", read);
        return () => {
            window.removeEventListener(CHANGED, read);
            window.removeEventListener("storage", read);
        };
    }, []);
    return prefs;
}

/** The volume, and a way to change it - for a slider. */
export function useSoundboardVolume(): [number, (volume: number) => void] {
    const prefs = useSoundboardPrefs();
    const change = useCallback((volume: number) => void setSoundboardVolume(volume), []);
    return [prefs.volume, change];
}
