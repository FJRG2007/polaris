/**
 * What a Polaris key should show, from where the deck stands, what the key is
 * set to and the last state Polaris sent for it. Pure, so every case the keys
 * can be in is tested without a Stream Deck.
 */

import { ICONS } from "./icons";
import type { WordKey } from "./words";
import type { KeyFace } from "./render";
import { DOUBLE_MS, HOLD_MS, windowMs, type Gesture, type GestureSet } from "./presses";
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
    /** Another catalogue entry run by a double press. */
    double?: Binding;
    /** Another catalogue entry run by holding the key. */
    hold?: Binding;
    /** Set, the key alternates: one press runs `action`, the next this. */
    alternate?: Binding;
    /** Which of the two an alternating key runs next. */
    side?: "a" | "b";
    /** How long after a press a second one counts as a double press. */
    doubleMs?: number;
    /** How long a key is held before it counts as a hold. */
    holdMs?: number;
};

/** One more catalogue entry a key runs, and its settings. */
export type Binding = {
    action?: string;
    options?: { [name: string]: OptionValue };
};

/** Which gestures a key has an action for, with its windows. */
export function gesturesOf(settings: KeySettings): GestureSet {
    return {
        double: Boolean(settings.double?.action),
        hold: Boolean(settings.hold?.action),
        doubleMs: windowMs(settings.doubleMs, DOUBLE_MS),
        holdMs: windowMs(settings.holdMs, HOLD_MS)
    };
}

/** Whether a key alternates between two actions. A key whose action is a
 *  real toggle never does: Polaris reads the device, and the key follows it
 *  instead of guessing from the last press. */
export function alternates(settings: KeySettings, entry: DeckAction | undefined): boolean {
    return Boolean(settings.alternate?.action) && entry?.kind !== "toggle";
}

/** What a gesture runs: null for the key's own action, as it is set. */
export function bindingFor(
    settings: KeySettings,
    entry: DeckAction | undefined,
    gesture: Gesture
): Binding | null {
    if (gesture === "double") return settings.double?.action ? settings.double : null;
    if (gesture === "hold") return settings.hold?.action ? settings.hold : null;
    if (alternates(settings, entry) && settings.side === "b") return settings.alternate!;
    return null;
}

/** Whether a gesture's run is what the key's state is read for: the key's own
 *  action with the same options. A lock key held to unlock is not. */
export function drawsOwnState(settings: KeySettings, binding: Binding | null): boolean {
    if (!binding) return true;
    if (binding.action !== settings.action) return false;
    const sorted = (options: Record<string, unknown>) =>
        JSON.stringify(Object.entries(options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return sorted(runOptions(binding)) === sorted(watchOptions(settings, "key"));
}

export function faceFor(
    link: Link,
    settings: KeySettings,
    entry: DeckAction | undefined,
    state: DeckState | undefined,
    words: Readonly<Record<WordKey, string>>,
    locked = false
): KeyFace {
    if (link === "unset") return { icon: "plug", tone: "off", label: words.connect };
    if (link === "unauthorized") return { icon: "lock", tone: "bad", label: words.signIn };
    if (!settings.action) return { icon: "circle-help", tone: "off", label: words.pick };
    // Set to something this deck may no longer use, or that is gone.
    if (!entry) {
        // Its owner may use it, the deck's key may not: connecting again does.
        if (locked && link === "online")
            return { icon: "lock", tone: "bad", label: words.reconnect };
        return link === "online"
            ? { icon: "circle-alert", tone: "off", label: words.pick }
            : { icon: "wifi-off", tone: "off", label: words.offline };
    }
    const label = settings.label?.trim() || entry.label;
    if (link !== "online") return { icon: entry.icon, tone: "off", label: words.offline };
    if (alternates(settings, entry)) {
        // On once the first of the two has run, until the second puts it back.
        const on = settings.side === "b";
        return { icon: entry.icon, tone: on ? "ok" : "idle", on, label };
    }
    if (!state) return { icon: entry.icon, tone: "idle", label };
    return {
        // The state's own icon when this plugin can draw it; a name newer than
        // the plugin keeps the action's.
        icon: state.icon && ICONS[state.icon] ? state.icon : entry.icon,
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

/** How a dial's value moves: Polaris sends it for a temperature, say; a
 *  brightness is the default. */
export interface DialRange {
    readonly min: number;
    readonly max: number;
    readonly step: number;
}

const LEVEL: DialRange = { min: 1, max: 100, step: 5 };

/** One dial turn, `step` a tick, held inside the range: five points a tick
 *  between 1 and 100 when the entry names no range. A dial never turned
 *  starts in the middle. */
export function turnLevel(level: unknown, ticks: number, range: DialRange = LEVEL): number {
    const middle = range === LEVEL ? 50 : (range.min + range.max) / 2;
    const from = typeof level === "number" && Number.isFinite(level) ? level : middle;
    const moved = Math.min(range.max, Math.max(range.min, from + ticks * range.step));
    // Whole numbers stay whole; a half-degree step keeps one decimal.
    return Number.isInteger(range.step) ? Math.round(moved) : Number(moved.toFixed(1));
}
