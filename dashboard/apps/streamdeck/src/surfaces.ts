/**
 * The plugin's actions by their manifest id, and which part of the catalogue
 * each one offers. The general key and dial take everything of their kind; the
 * call, soundboard and Places actions take only their own, so their pickers are
 * short.
 *
 * SDK-free, so the tests reach it.
 */

import type { DeckAction } from "./polaris";

export const PLUGIN_UUID = "io.github.fjrg2007.polaris";
export const KEY_UUID = `${PLUGIN_UUID}.key`;
export const DIAL_UUID = `${PLUGIN_UUID}.dial`;
export const TIMER_UUID = `${PLUGIN_UUID}.timer`;
/** The same key and dial, offering only one part of the catalogue. */
export const CALL_UUID = `${PLUGIN_UUID}.call`;
export const SOUND_UUID = `${PLUGIN_UUID}.sound`;
export const PLACES_UUID = `${PLUGIN_UUID}.places`;
export const PLACES_DIAL_UUID = `${PLUGIN_UUID}.places-dial`;

/** Which catalogue entries an action of the plugin can be set to. */
export type Surface = "key" | "dial" | "call" | "sound" | "places" | "places-dial";

const SURFACES: Readonly<Record<string, Surface>> = {
    [KEY_UUID]: "key",
    [DIAL_UUID]: "dial",
    [CALL_UUID]: "call",
    [SOUND_UUID]: "sound",
    [PLACES_UUID]: "places",
    [PLACES_DIAL_UUID]: "places-dial"
};

/** The surface a manifest action id stands for, or null for one that has no
 *  catalogue (the timer). */
export function surfaceOf(manifestId: string): Surface | null {
    return SURFACES[manifestId] ?? null;
}

/** The catalogue entries a surface offers. */
export function offered(catalogue: readonly DeckAction[], surface: Surface): DeckAction[] {
    return catalogue.filter((entry) => {
        const dial = entry.kind === "dial";
        switch (surface) {
            case "key":
                return !dial;
            case "dial":
                return dial;
            case "call":
                return entry.area === "call" && entry.id !== "call.sound";
            case "sound":
                return entry.id === "call.sound";
            case "places":
                return entry.area === "places" && !dial;
            case "places-dial":
                return entry.area === "places" && dial;
        }
    });
}
