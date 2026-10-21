/**
 * Polaris's deck catalogue, as Companion's actions, feedbacks, variables and
 * presets.
 *
 * The catalogue is the same one the Stream Deck plugin reads - already
 * filtered to what the signed-in account may use - so nothing here decides
 * what is allowed; it only reshapes each entry into the form Companion asks
 * for. Pure, so every shape is tested without a Companion.
 *
 * What maps to what:
 * - a `run`, `toggle` or `dial` entry is an action, its fields its options;
 *   a dial's level (1-100) is an option of its own, since a Companion button
 *   sets a level rather than turning to one;
 * - a `live` entry is a feedback that colours the button by the state Polaris
 *   sends, and a toggle also a yes/no feedback for "on";
 * - a `live` entry that needs nothing to be picked is also a variable, watched
 *   all the time, so `$(polaris:chat_unread)` works on any button;
 * - `open` entries are left out: they open a page in a browser, and the
 *   computer Companion runs on is often not the one in front of anybody.
 */

import type { DeckAction, DeckField, DeckState } from "../../streamdeck/src/polaris";

/** A field as Companion draws it. A structural subset of the SDK's input
 *  fields, so this file needs no SDK and the tests need no Companion. */
export type OptionField =
    | {
          readonly type: "textinput";
          readonly id: string;
          readonly label: string;
          readonly default: string;
          readonly useVariables: boolean;
      }
    | {
          readonly type: "number";
          readonly id: string;
          readonly label: string;
          readonly default: number;
          readonly min: number;
          readonly max: number;
      }
    | {
          readonly type: "dropdown";
          readonly id: string;
          readonly label: string;
          readonly default: string;
          readonly choices: { id: string; label: string }[];
      }
    | {
          readonly type: "checkbox";
          readonly id: string;
          readonly label: string;
          readonly default: boolean;
      };

/** Option values as Companion hands them back. */
export type OptionValues = { [name: string]: unknown };

/** The option a dial's level is set with, when the catalogue has none. */
export const LEVEL_OPTION = "level";
/** The feedback option that decides whether the value is drawn as text. */
export const TEXT_OPTION = "_text";

/** Companion ids are plain words: `chat.unread` is `chat_unread`. */
export function companionId(deckId: string): string {
    return deckId.replace(/[^A-Za-z0-9_]/g, "_");
}

/** The entries a Companion button can run. */
export function runnable(catalogue: readonly DeckAction[]): DeckAction[] {
    return catalogue.filter((entry) => entry.kind !== "open" && entry.kind !== "state");
}

/** The entries Polaris streams a state for. */
export function watchable(catalogue: readonly DeckAction[]): DeckAction[] {
    return catalogue.filter((entry) => entry.live && entry.kind !== "open");
}

/** A live entry needs nothing picked, so its state can be a variable. */
export function standalone(entry: DeckAction): boolean {
    return entry.options.every((field) => !field.required || defaultOf(field) !== undefined);
}

/** What a field starts as: the first choice, the lower bound, nothing to type. */
function defaultOf(field: DeckField): string | number | undefined {
    if (field.type === "choice") return field.choices?.[0]?.value;
    if (field.type === "number") return field.min ?? 0;
    return undefined;
}

export function optionField(field: DeckField): OptionField {
    if (field.type === "choice") {
        const choices = (field.choices ?? []).map((choice) => ({
            id: choice.value,
            label: choice.label
        }));
        return {
            type: "dropdown",
            id: field.name,
            label: field.label,
            default: choices[0]?.id ?? "",
            choices
        };
    }
    if (field.type === "number") {
        const min = field.min ?? -1_000_000;
        const max = field.max ?? 1_000_000;
        return {
            type: "number",
            id: field.name,
            label: field.label,
            default: Math.min(max, Math.max(min, 0)),
            min,
            max
        };
    }
    return {
        type: "textinput",
        id: field.name,
        label: field.label,
        default: "",
        useVariables: true
    };
}

/** An action's options: the entry's fields, and a dial's level. */
export function actionOptions(entry: DeckAction): OptionField[] {
    const fields = entry.options.map(optionField);
    if (entry.kind === "dial" && !fields.some((field) => field.id === LEVEL_OPTION)) {
        fields.push({
            type: "number",
            id: LEVEL_OPTION,
            label: "Level",
            default: 50,
            min: 1,
            max: 100
        });
    }
    return fields;
}

/** A feedback's options: the fields that pick what is watched. A dial's level
 *  is where it is set to, not what it shows, so it is not one of them. */
export function feedbackOptions(entry: DeckAction): OptionField[] {
    return entry.options.filter((field) => field.name !== LEVEL_OPTION).map(optionField);
}

/**
 * The values Polaris is sent: only the entry's own fields (plus a dial's
 * level), numbers as numbers, and text that is empty left out so Polaris's own
 * check reports what is missing rather than an empty string.
 */
export function deckOptions(
    entry: DeckAction,
    values: OptionValues,
    forRun = true
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let names = entry.options.map((field) => field.name);
    if (!forRun) names = names.filter((name) => name !== LEVEL_OPTION);
    else if (entry.kind === "dial" && !names.includes(LEVEL_OPTION)) names.push(LEVEL_OPTION);
    for (const name of names) {
        const field = entry.options.find((candidate) => candidate.name === name);
        const value = values[name];
        if (value === undefined || value === null || value === "") continue;
        if (field?.type === "number" || name === LEVEL_OPTION) {
            const number = Number(value);
            if (Number.isFinite(number)) out[name] = number;
        } else out[name] = typeof value === "string" ? value : String(value);
    }
    return out;
}

/** Companion colours are 0xRRGGBB numbers. */
export const COLORS = {
    white: 0xffffff,
    black: 0x000000,
    idle: 0x262626,
    ok: 0x15803d,
    warn: 0xb45309,
    bad: 0xb91c1c,
    off: 0x404040
} as const;

/** How a button looks for a state: its colour from the tone, and - when the
 *  feedback is set to - the value or status line under the name. */
export function stateStyle(
    label: string,
    state: DeckState | undefined,
    withText: boolean
): { bgcolor: number; color: number; text?: string } {
    if (!state) return { bgcolor: COLORS.idle, color: COLORS.white };
    const style: { bgcolor: number; color: number; text?: string } = {
        bgcolor: state.on === false ? COLORS.off : COLORS[state.tone],
        color: COLORS.white
    };
    const shown = state.value ?? state.detail;
    if (withText) style.text = shown ? `${label}\n${shown}` : label;
    return style;
}

/** A state as a variable's value: the number or status it carries, else its
 *  tone - "ok", "warn", "bad" or "idle" - which is still worth a condition. */
export function stateValue(state: DeckState | undefined): string {
    if (!state) return "";
    if (state.value !== undefined) return state.value;
    if (state.on !== undefined) return state.on ? "on" : "off";
    return state.detail ?? state.tone;
}

/** One entry of what the state stream watches. */
export interface Watched {
    readonly key: string;
    readonly action: string;
    readonly options: Record<string, unknown>;
}

/** The stream key a variable is read under. */
export function variableKey(entry: DeckAction): string {
    return `var:${companionId(entry.id)}`;
}

/** Polaris watches at most this many keys on one stream. */
export const MAX_WATCHED = 64;

/**
 * What the stream should watch: every standalone live entry (for its variable)
 * and every feedback on a button, in that order, at most `MAX_WATCHED`.
 */
export function watchList(
    catalogue: readonly DeckAction[],
    feedbacks: ReadonlyMap<string, Watched>
): Watched[] {
    const watched: Watched[] = [];
    for (const entry of watchable(catalogue)) {
        if (standalone(entry)) {
            watched.push({ key: variableKey(entry), action: entry.id, options: defaults(entry) });
        }
    }
    for (const item of feedbacks.values()) watched.push(item);
    return watched.slice(0, MAX_WATCHED);
}

/** The options an entry is watched or run with when nothing was picked. */
export function defaults(entry: DeckAction): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of entry.options) {
        const value = defaultOf(field);
        if (value !== undefined && field.name !== LEVEL_OPTION) out[field.name] = value;
    }
    return out;
}

/** The variables the catalogue gives: each standalone live entry's value. */
export function catalogueVariables(
    catalogue: readonly DeckAction[]
): { id: string; name: string }[] {
    return watchable(catalogue)
        .filter(standalone)
        .map((entry) => ({ id: companionId(entry.id), name: entry.label }));
}

/** The variables that are always there, whatever the catalogue holds. */
export const FIXED_VARIABLES = [
    { id: "connection", name: "Connection to Polaris" },
    { id: "account", name: "Signed-in account" },
    { id: "sign_in_code", name: "Code to approve in Polaris" },
    { id: "sign_in_url", name: "Page to approve the code on" },
    { id: "update_version", name: "Newer module version, empty when this is the newest" },
    { id: "update_url", name: "Page to download the newer module from" }
] as const;

/** A preset button, in the plain shape this file produces. */
export interface PresetSpec {
    readonly id: string;
    readonly area: string;
    readonly name: string;
    readonly actionId: string | null;
    readonly options: Record<string, unknown>;
    readonly feedbackId: string | null;
}

/**
 * A ready-made button for each entry that works as dropped: one that needs
 * nothing typed. It runs the entry (when it runs anything) and shows its state
 * (when it has one).
 */
export function presetSpecs(catalogue: readonly DeckAction[]): PresetSpec[] {
    const specs: PresetSpec[] = [];
    for (const entry of catalogue) {
        if (entry.kind === "open" || !standalone(entry)) continue;
        const options = defaults(entry);
        if (entry.kind === "dial") options[LEVEL_OPTION] = 50;
        specs.push({
            id: companionId(entry.id),
            area: entry.area,
            name: entry.label,
            actionId: entry.kind === "state" ? null : companionId(entry.id),
            options,
            feedbackId: entry.live ? companionId(entry.id) : null
        });
    }
    return specs;
}
