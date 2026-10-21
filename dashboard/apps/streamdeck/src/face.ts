/**
 * What a Polaris key should show, from where the deck stands, what the key is
 * set to and the last state Polaris sent for it. Pure, so every case the keys
 * can be in is tested without a Stream Deck.
 */

import type { WordKey } from "./words";
import type { KeyFace } from "./render";
import type { DeckAction, DeckState, Link } from "./polaris";

/** A setting value, as the inspector writes it. */
export type OptionValue = string | number | boolean | null;

/** A Polaris key's own settings. A type rather than an interface, so it fits
 *  the SDK's JSON settings type. */
export type KeySettings = {
    /** The catalogue entry, by id. */
    action?: string;
    /** Its settings, as the inspector wrote them. */
    options?: { [name: string]: OptionValue };
    /** A name of the person's own, drawn instead of the action's. */
    label?: string;
};

export function faceFor(
    link: Link,
    settings: KeySettings,
    entry: DeckAction | undefined,
    state: DeckState | undefined,
    words: Readonly<Record<WordKey, string>>
): KeyFace {
    if (link === "unset") return { icon: "plug", tone: "off", label: words.connect };
    if (link === "unauthorized") return { icon: "lock", tone: "bad", label: words.signIn };
    if (!settings.action) return { icon: "circle-help", tone: "off", label: words.pick };
    // Set to something this deck may no longer use, or that is gone.
    if (!entry) {
        return link === "online"
            ? { icon: "circle-alert", tone: "off", label: words.pick }
            : { icon: "wifi-off", tone: "off", label: words.offline };
    }
    const label = settings.label?.trim() || entry.label;
    if (link !== "online") return { icon: entry.icon, tone: "off", label: words.offline };
    if (!state) return { icon: entry.icon, tone: "idle", label };
    return {
        icon: entry.icon,
        tone: state.tone,
        ...(state.value === undefined ? {} : { value: state.value }),
        ...(state.on === undefined ? {} : { on: state.on }),
        // A status line Polaris sent says more than the action's name.
        label: state.detail || label
    };
}

/** The settings a key's action is run with: its options, plus the level a
 *  dial last landed on. */
export function runOptions(settings: KeySettings): Record<string, unknown> {
    const options = settings.options;
    return options && typeof options === "object" && !Array.isArray(options) ? { ...options } : {};
}

/** The settings a key's state is read with: its run's, but for a dial the
 *  level it last landed on, which is where it is turned to rather than what
 *  it shows - so turning it does not reopen the state stream. */
export function watchOptions(
    settings: KeySettings,
    surface: "key" | "dial"
): Record<string, unknown> {
    const options = runOptions(settings);
    if (surface === "dial") delete options.level;
    return options;
}

/** One dial turn, five points a tick, held between 1 and 100. */
export function turnLevel(level: unknown, ticks: number): number {
    const from = typeof level === "number" && Number.isFinite(level) ? level : 50;
    return Math.min(100, Math.max(1, Math.round(from + ticks * 5)));
}
