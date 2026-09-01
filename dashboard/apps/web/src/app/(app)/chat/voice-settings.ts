"use client";

/**
 * Everything this browser has been told about how it speaks and listens.
 *
 * Per browser, like the microphone, the cleanup level and the volumes, and for
 * the same reason: these are facts about a machine in a room. The laptop in the
 * kitchen and the desk with the headset want different answers, and an account
 * that carried one of them between the two would be wrong on whichever it was
 * not set on.
 *
 * One record rather than a key each. They are read together - the call reads all
 * of them when it opens a microphone - and eight storage keys is eight chances
 * for a browser to hold half a setting.
 *
 * Nothing here is a preference somebody has to have an opinion about. Every
 * default is what Polaris did before any of this existed, so an account that
 * never opens the screen behaves exactly as it did: the microphone is open, the
 * browser's own processors are on, and nothing lowers anything.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.voice.settings";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:voice-settings";

/**
 * How a microphone decides whether it is sending.
 *
 * `open` is what Polaris has always done: the track is live until somebody
 * presses mute. `activity` closes it between sentences, and `ptt` closes it
 * except while a key is held. The default stays `open` - a call where somebody
 * is cut off mid-word because a threshold disagreed with them is a worse failure
 * than a call that carries a keyboard.
 */
export const INPUT_MODES = ["open", "activity", "ptt"] as const;
export type InputMode = (typeof INPUT_MODES)[number];

export const INPUT_MODE_LABELS: Record<InputMode, string> = {
    open: "Always on",
    activity: "Voice activity",
    ptt: "Push to talk"
};

export const INPUT_MODE_NOTES: Record<InputMode, string> = {
    open: "Your microphone is live until you mute it. What Polaris does unless you say otherwise.",
    activity: "Your microphone opens when you speak and closes when you stop.",
    ptt: "Your microphone is closed except while you hold a key."
};

export interface VoiceSettings {
    readonly inputMode: InputMode;
    /**
     * The key held to talk, as a `KeyboardEvent.code` - "Space", "KeyV". A code
     * rather than a key, so a layout that puts a different letter under the same
     * finger still works and a shifted press is the same key.
     */
    readonly pttKey: string;
    /** How long the microphone stays open after the key is let go, in
     *  milliseconds. Zero cuts the last syllable off; a moment does not. */
    readonly pttReleaseMs: number;
    /**
     * How loud counts as speaking, 0 to 100, for voice activity.
     *
     * Read as a percentage of the meter people can see moving on the settings
     * screen, which is the only way anybody can set this: a number in decibels
     * is a number nobody has an opinion about.
     */
    readonly activityThreshold: number;
    /**
     * Whether voice activity listens to the cleaned-up microphone rather than
     * the raw one.
     *
     * The difference is real and it is the whole reason this is a setting: a
     * threshold on the raw input is opened by a keyboard, a fan and a door, and
     * the same threshold after the noise model has run is opened by a voice.
     * Costs whatever the model costs, which is why it is not simply always on.
     */
    readonly advancedActivity: boolean;
    /** Whether the browser's own gain control is used. Off is for somebody whose
     *  level keeps being pumped up and down between sentences. */
    readonly autoGainControl: boolean;
    /**
     * Whether to ask the browser for the microphone exactly as it is.
     *
     * Turns off echo cancellation, noise suppression and gain control together -
     * the browser's whole input chain - for an interface or a processed feed
     * that has already done all of it, where doing it twice is what is ruining
     * the sound.
     */
    readonly bypassProcessing: boolean;
    /** Whether to say so when the microphone has been silent for a while during
     *  a call. */
    readonly noAudioWarning: boolean;
    /** Whether to ask before leaving a call to open another room. */
    readonly switchWarning: boolean;
    /** Whether the call quietens while you are speaking. */
    readonly attenuate: boolean;
    /** How far it quietens, 0 to 100, where 100 is silent. */
    readonly attenuation: number;
}

export const VOICE_DEFAULTS: VoiceSettings = {
    inputMode: "open",
    pttKey: "Space",
    pttReleaseMs: 200,
    activityThreshold: 12,
    advancedActivity: false,
    autoGainControl: true,
    bypassProcessing: false,
    noAudioWarning: true,
    switchWarning: false,
    attenuate: false,
    attenuation: 50
};

function clamp(value: unknown, low: number, high: number, fallback: number): number {
    const number = typeof value === "number" ? value : Number.NaN;
    if (!Number.isFinite(number)) return fallback;
    return Math.min(high, Math.max(low, Math.round(number)));
}

/**
 * What is stored, or the defaults.
 *
 * Every field is checked on the way out rather than trusted: local storage
 * belongs to whoever owns the browser, and a threshold of `"loud"` or a release
 * of a million would each be a call nobody can be heard on.
 */
export function voiceSettings(): VoiceSettings {
    if (typeof window === "undefined") return VOICE_DEFAULTS;
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return VOICE_DEFAULTS;
        const held = JSON.parse(raw) as Partial<VoiceSettings>;
        return {
            inputMode: INPUT_MODES.includes(held.inputMode as InputMode)
                ? (held.inputMode as InputMode)
                : VOICE_DEFAULTS.inputMode,
            pttKey:
                typeof held.pttKey === "string" && held.pttKey.length > 0 && held.pttKey.length <= 32
                    ? held.pttKey
                    : VOICE_DEFAULTS.pttKey,
            pttReleaseMs: clamp(held.pttReleaseMs, 0, 2000, VOICE_DEFAULTS.pttReleaseMs),
            activityThreshold: clamp(held.activityThreshold, 0, 100, VOICE_DEFAULTS.activityThreshold),
            advancedActivity: held.advancedActivity === true,
            // The two that default to on are read as "not false", so a record
            // written before either existed keeps the behaviour it had.
            autoGainControl: held.autoGainControl !== false,
            bypassProcessing: held.bypassProcessing === true,
            noAudioWarning: held.noAudioWarning !== false,
            switchWarning: held.switchWarning === true,
            attenuate: held.attenuate === true,
            attenuation: clamp(held.attenuation, 0, 100, VOICE_DEFAULTS.attenuation)
        };
    } catch {
        return VOICE_DEFAULTS;
    }
}

export function setVoiceSettings(next: Partial<VoiceSettings>): VoiceSettings {
    const settled: VoiceSettings = { ...voiceSettings(), ...next };
    if (typeof window !== "undefined") {
        try {
            window.localStorage.setItem(KEY, JSON.stringify(settled));
        } catch {
            // It still applies to what is open now; it just will not be
            // remembered. Private browsing, or a full quota.
        }
        window.dispatchEvent(new Event(CHANGED));
    }
    return settled;
}

/** The settings, and a way to change one. Follows the other tabs of this
 *  browser, since all of them are speaking through the same machine. */
export function useVoiceSettings(): [VoiceSettings, (next: Partial<VoiceSettings>) => void] {
    // Never read during render: the server has no local storage, and a value
    // that differed between the two would fail hydration.
    const [settings, setSettings] = useState<VoiceSettings>(VOICE_DEFAULTS);

    useEffect(() => {
        const read = () => setSettings(voiceSettings());
        read();
        window.addEventListener(CHANGED, read);
        window.addEventListener("storage", read);
        return () => {
            window.removeEventListener(CHANGED, read);
            window.removeEventListener("storage", read);
        };
    }, []);

    const change = useCallback((next: Partial<VoiceSettings>) => {
        setSettings(setVoiceSettings(next));
    }, []);

    return [settings, change];
}
