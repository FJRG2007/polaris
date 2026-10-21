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
export type DeckArea = "chat" | "status" | "watch" | "deploy" | "places" | "polaris";

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
        /** For `choice`: the tool that lists them and how to read its answer. */
        readonly choices?: {
            readonly tool: string;
            readonly input: Record<string, unknown>;
            readonly pick: (structured: unknown) => { value: string; label: string }[];
        };
    }[];
    /** The tool a press calls, and its input. `step` is a dial's turn, in
     *  ticks; `current` is the state last read, for a toggle. */
    readonly run: {
        readonly tool: string;
        readonly input: (
            options: Record<string, unknown>,
            press: { readonly step?: number; readonly current?: DeckState }
        ) => unknown;
    };
    /** The tool that reads its state, for a live action. `locale` is the
     *  reader's, for any words the state carries. */
    readonly read?: {
        readonly tool: string;
        readonly input: (options: Record<string, unknown>) => unknown;
        readonly pick: (structured: unknown, locale: Locale) => DeckState;
    };
}
