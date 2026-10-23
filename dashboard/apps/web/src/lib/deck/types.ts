/**
 * The shapes the Stream Deck API speaks, shared by core's actions and the ones
 * an installed app contributes through the extension registry.
 *
 * Client-safe: types only.
 */

import type { Locale } from "@polaris/core";

/** What pressing it does. `run` acts once, `toggle` flips something whose state
 *  the key shows, `state` only shows, `dial` turns, and `open` has the plugin
 *  open a Polaris page - nothing is asked of the server for that. */
export type DeckActionKind = "run" | "toggle" | "state" | "dial" | "open";

/** The heading the plugin's picker groups actions under. */
export type DeckArea =
    "chat" | "call" | "status" | "watch" | "deploy" | "places" | "polaris" | "tools";

/** One setting an action takes, as the plugin's settings screen draws it. */
export interface DeckOptionField {
    readonly name: string;
    readonly type: "text" | "number" | "choice";
    readonly label: string;
    readonly required: boolean;
    /** For `choice`: what can be picked, already narrowed to what this person
     *  reaches. */
    readonly choices?: readonly { readonly value: string; readonly label: string }[];
    readonly min?: number;
    readonly max?: number;
}

/** One entry of the catalogue, as `GET /api/deck/actions` hands it out. */
export interface DeckActionView {
    readonly id: string;
    readonly kind: DeckActionKind;
    readonly area: DeckArea;
    readonly label: string;
    /** A lucide-style icon name the plugin draws; unknown names fall back. */
    readonly icon: string;
    readonly options: readonly DeckOptionField[];
    /** Whether `GET /api/deck/state` reports a value for it. */
    readonly live: boolean;
    /** For `open`: the page, joined to the Polaris address by the plugin. */
    readonly path?: string;
    /** It cannot be undone: the key asks for a second press before it runs. */
    readonly confirm?: boolean;
    /** For a dial: the range its value runs over and how far a tick moves it. */
    readonly dial?: DeckDialRange;
}

/** A dial's range: a temperature, say, rather than a 1 to 100 level. */
export interface DeckDialRange {
    readonly min: number;
    readonly max: number;
    readonly step: number;
}

/** Tone of a key: drawn as its colour. */
export type DeckTone = "ok" | "warn" | "bad" | "idle";

/** What a key shows. */
export interface DeckState {
    readonly tone: DeckTone;
    /** A short value - a count, a latency - drawn large. */
    readonly value?: string;
    /** Whether a toggle is on. */
    readonly on?: boolean;
    /** One more short line under the value. */
    readonly detail?: string;
    /** An icon for what it is now - a crossed-out microphone, a fan rather
     *  than a bulb - drawn instead of the action's. A name the plugin does not
     *  know falls back to the action's own. */
    readonly icon?: string;
    /** What pressing the key does from here, for a plugin that shows it before
     *  Polaris answers. Absent when the key cannot know ahead. */
    readonly press?: DeckPress;
    /** For a timer kept in Polaris: what the key counts down from, so it ticks
     *  every second between readings and agrees with every other screen. */
    readonly countdown?: DeckCountdown;
}

/**
 * A countdown as Polaris has it. `endsAt` is when a running one reaches zero,
 * on Polaris's clock; `serverNow` is that clock when it was read, so a deck
 * whose own clock is off counts to the same second (the skew Calendar's
 * screens apply). A stopped one carries only what is left.
 */
export interface DeckCountdown {
    readonly state: "running" | "paused" | "rung" | "idle";
    readonly remainingMs: number;
    /** Its full length, for a reset or a progress ring. */
    readonly durationMs: number;
    readonly endsAt?: number;
    readonly serverNow?: number;
    /** A focus cycle: the phase it is on. */
    readonly phase?: "focus" | "short" | "long";
}

/** A key's face without what a press would do. */
export type DeckFace = Omit<DeckState, "press">;

/**
 * What a press would do from the state a key shows: the face it shows at once,
 * while the command is on its way, or that the device already is where the
 * press would put it - a lock pressed to lock while locked - so nothing is
 * sent. The plugin puts the face back if Polaris refuses or does not answer.
 */
export interface DeckPress {
    readonly face?: DeckFace;
    readonly noop?: true;
    /** What the press changes on keys showing something else - deafening
     *  mutes the microphone's key, hanging up ends every call key - drawn on
     *  them at once and put back with the pressed key's own face. */
    readonly also?: readonly DeckAlso[];
}

/** A face a press draws on other keys: every key showing `action`, with
 *  these settings when `options` is given and whatever its settings when not. */
export interface DeckAlso {
    readonly action: string;
    readonly options?: Readonly<Record<string, unknown>>;
    readonly face: DeckFace;
}

/** An action the deck's key does not carry the permission for, though its
 *  owner holds it: connecting the deck again would allow it. */
export interface DeckLockedAction {
    readonly id: string;
    readonly label: string;
    /** "Reconnect this deck to allow ...", in its owner's words. */
    readonly message: string;
}

/** What a run answers. `message` is a refusal written for a person. */
export type DeckRunResult =
    | { readonly ok: true; readonly state?: DeckState }
    | { readonly ok: false; readonly message: string };

/**
 * What validates an action's settings. Structural rather than a zod type, so an
 * app's own copy of zod - which may be another build of it - fits as well.
 */
export interface DeckOptionsSchema {
    safeParse(
        input: unknown
    ): { success: true; data: Record<string, unknown> } | { success: false };
}

/** The person a call acts as, as the deck's key carries them. */
export interface DeckCaller {
    readonly userId: string;
    readonly isAdmin: boolean;
    readonly keyId: string;
    /** The key's scopes, already intersected with what its owner holds. */
    readonly scopes: readonly string[];
    readonly locale: Locale;
}

/**
 * An action an installed app offers a deck, bound to one of its own MCP tools.
 *
 * Bound to a tool rather than to code of its own so the deck reaches exactly
 * what an assistant does, through the same checks: the tool is looked up in the
 * live catalogue, its scope checked against the key, its input parsed by its
 * own schema. An app that is uninstalled has no tools and so no deck actions.
 */
export interface AppDeckAction {
    readonly id: string;
    readonly kind: Exclude<DeckActionKind, "open">;
    readonly area: DeckArea;
    readonly icon: string;
    /** Every locale, so no reader gets another language's name. */
    readonly label: Readonly<Record<Locale, string>>;
    /** The permission the deck's key must hold for it to be offered at all. */
    readonly scope: string;
    readonly options: DeckOptionsSchema;
    /** The settings screen's fields, labels in every locale. */
    readonly fields: readonly {
        readonly name: string;
        readonly type: DeckOptionField["type"];
        readonly label: Readonly<Record<Locale, string>>;
        readonly required: boolean;
        readonly min?: number;
        readonly max?: number;
        /** For `choice`: fixed values, named in every locale. */
        readonly fixed?: readonly {
            readonly value: string;
            readonly label: Readonly<Record<Locale, string>>;
        }[];
        /** For `choice`: the tool that lists them and how to read its answer,
         *  after any `fixed` ones. */
        readonly choices?: {
            readonly tool: string;
            readonly input: Record<string, unknown>;
            readonly pick: (structured: unknown) => { value: string; label: string }[];
        };
    }[];
    /** It cannot be undone: the key asks for a second press before it runs. */
    readonly confirm?: boolean;
    /** For a dial: its range, when it is not a 1 to 100 level. */
    readonly dial?: DeckDialRange;
    /** The tool a press calls, and its input. `step` is a dial's turn, in
     *  ticks; `push` says a dial was pushed rather than turned; `current` is
     *  the state last read, for a toggle. A null input is a press that has
     *  nothing to send (a step from a value the device has not reported). */
    readonly run: {
        /** One tool, or the one this press needs - creating a timer the
         *  first time, changing it after - chosen from what the read answered. */
        readonly tool:
            | string
            | ((
                  options: Record<string, unknown>,
                  press: { readonly step?: number; readonly read?: unknown }
              ) => string);
        readonly input: (
            options: Record<string, unknown>,
            press: {
                readonly step?: number;
                readonly push?: boolean;
                readonly current?: DeckState;
                /** What the read tool answered, for a press that moves from it. */
                readonly read?: unknown;
            }
        ) => unknown;
    };
    /** The tool that reads its state, for a live action. `locale` is the
     *  reader's, for any words the state carries. */
    readonly read?: {
        readonly tool: string;
        readonly input: (options: Record<string, unknown>) => unknown;
        readonly pick: (
            structured: unknown,
            locale: Locale,
            /** The key's settings, for a read shared by many keys. */
            options?: Record<string, unknown>
        ) => DeckState;
        /** What a press does from the state just picked, with the key's
         *  settings and what the tool answered. */
        readonly press?: (
            state: DeckState,
            options: Record<string, unknown>,
            structured: unknown,
            locale: Locale
        ) => DeckPress | undefined;
    };
}
