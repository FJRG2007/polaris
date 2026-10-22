/**
 * The Stream Deck's catalogue, its runs and its live state.
 *
 * Core's actions and the installed apps' (through the extension registry, so
 * core never imports an app) are held to one rule: an action is offered only
 * when the deck's key carries the permission it needs, and the same check runs
 * again on every press, because a key's scopes are narrowed to what its owner
 * holds at every call and the catalogue the plugin cached may be older.
 *
 * Server-only.
 */

import { z } from "zod";
import { callTool } from "./tool-call";
import { isDeckScope } from "./scopes";
import { scopesAvailableTo } from "@polaris/auth";
import { translatorFor } from "@/lib/i18n/translate";
import { appDeckActions } from "@/lib/app-extensions/registry";
import {
    deckTools,
    toolInput,
    toolView,
    TOOL_PREFIX,
    type DeckTool,
    type ToolListings
} from "./tool-actions";
import { coreDeckActions, type CoreDeckAction } from "./core-actions";
import type {
    AppDeckAction,
    DeckActionView,
    DeckCaller,
    DeckLockedAction,
    DeckOptionField,
    DeckRunResult,
    DeckState
} from "./types";

/** The words labels and refusals are read from: the `api` catalog. */
export type DeckWords = (key: string, values?: Record<string, string | number>) => string;

/** One action, wherever it came from, in the one shape the service runs. */
interface Resolved {
    readonly id: string;
    readonly scope: string | null;
    readonly core?: CoreDeckAction;
    readonly app?: AppDeckAction;
    /** An MCP tool offered as it is; already narrowed to the key's scopes. */
    readonly tool?: DeckTool;
}

/** The most choices one picker carries. */
const CHOICE_LIMIT = 100;

function allowed(scope: string | null, caller: DeckCaller): boolean {
    return scope === null || caller.scopes.includes(scope);
}

/**
 * The scopes a deck's key lacks though its owner holds them - a deck connected
 * before the scope was offered, or approved with it unticked. Connecting again
 * is what allows them, and a key set to one says so instead of failing
 * silently. Read once per request, lazily.
 */
function reconnectable(caller: DeckCaller): (scope: string | null) => Promise<boolean> {
    let held: Promise<Set<string>> | null = null;
    return async (scope) => {
        if (scope === null || caller.scopes.includes(scope) || !isDeckScope(scope)) return false;
        held ??= scopesAvailableTo(caller.userId, caller.isAdmin)
            .then((scopes) => new Set<string>(scopes))
            .catch(() => new Set<string>());
        return (await held).has(scope);
    };
}

/** "Reconnect this deck to allow: Control places and cameras." */
function reconnectMessage(scope: string, caller: DeckCaller, words: DeckWords): string {
    const scopes = translatorFor(caller.locale, "mcp") as unknown as DeckWords;
    return words("deck.errors.reconnect", { what: scopes(`scopes.${scope.replace(".", "_")}`) });
}

/** The actions a key could be set to once the deck is connected again. */
export async function lockedActions(
    caller: DeckCaller,
    words: DeckWords
): Promise<DeckLockedAction[]> {
    const may = reconnectable(caller);
    const locked: DeckLockedAction[] = [];
    for (const action of await everyAction(words, caller, false)) {
        if (!action.scope || !(await may(action.scope))) continue;
        locked.push({
            id: action.id,
            label: action.core
                ? words(`deck.actions.${action.id.replace(".", "_")}`)
                : action.app!.label[caller.locale],
            message: reconnectMessage(action.scope, caller, words)
        });
    }
    return locked;
}

/** Every action there is right now: core's and the apps' before the key's
 *  scopes are applied, the tools after (a tool's scope is the MCP one). The
 *  tools are left out when nothing asked for one. */
async function everyAction(
    words: DeckWords,
    caller: DeckCaller,
    withTools = true
): Promise<Resolved[]> {
    const core = coreDeckActions(words("deck.errors.refused")).map((action) => ({
        id: action.id,
        scope: action.scope,
        core: action
    }));
    const taken = new Set(core.map((action) => action.id));
    const apps: Resolved[] = [];
    for (const action of await appDeckActions()) {
        // An app's id lives under its own name, never over one of core's.
        if (taken.has(action.id) || !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(action.id)) continue;
        taken.add(action.id);
        apps.push({ id: action.id, scope: action.scope, app: action });
    }
    if (!withTools) return [...core, ...apps];
    const tools = (await deckTools(caller)).map((tool) => ({ id: tool.id, scope: null, tool }));
    return [...core, ...apps, ...tools];
}

async function viewOf(
    action: Resolved,
    caller: DeckCaller,
    words: DeckWords,
    listings: ToolListings
): Promise<DeckActionView> {
    if (action.tool) return toolView(action.tool, caller, words, listings);
    if (action.core) {
        const core = action.core;
        const fields: DeckOptionField[] = await Promise.all(
            core.fields.map(async (field) => ({
                name: field.name,
                type: field.type,
                label: words(`deck.fields.${field.name}`),
                required: field.required,
                ...(field.min === undefined ? {} : { min: field.min }),
                ...(field.max === undefined ? {} : { max: field.max }),
                ...(field.fixed
                    ? {
                          choices: field.fixed.map((value) => ({
                              value,
                              label: words(`deck.choice.${value}`)
                          }))
                      }
                    : field.read
                      ? { choices: (await field.read(caller)).slice(0, CHOICE_LIMIT) }
                      : {})
            }))
        );
        return {
            id: core.id,
            kind: core.kind,
            area: core.area,
            label: words(`deck.actions.${core.id.replace(".", "_")}`),
            icon: core.icon,
            options: fields,
            live: core.read !== undefined,
            ...(core.path ? { path: core.path } : {})
        };
    }
    const app = action.app!;
    const fields: DeckOptionField[] = await Promise.all(
        app.fields.map(async (field) => {
            let choices: { value: string; label: string }[] | undefined;
            if (field.fixed) {
                choices = field.fixed.map((choice) => ({
                    value: choice.value,
                    label: choice.label[caller.locale]
                }));
            } else if (field.choices) {
                const outcome = await callTool(caller, field.choices.tool, field.choices.input);
                choices = outcome.ok
                    ? field.choices.pick(outcome.structured).slice(0, CHOICE_LIMIT)
                    : [];
            }
            return {
                name: field.name,
                type: field.type,
                label: field.label[caller.locale],
                required: field.required,
                ...(field.min === undefined ? {} : { min: field.min }),
                ...(field.max === undefined ? {} : { max: field.max }),
                ...(choices ? { choices } : {})
            };
        })
    );
    return {
        id: app.id,
        kind: app.kind,
        area: app.area,
        label: app.label[caller.locale],
        icon: app.icon,
        options: fields,
        live: app.read !== undefined,
        ...(app.confirm ? { confirm: true } : {}),
        ...(app.dial ? { dial: app.dial } : {})
    };
}

/** What this key may put on a deck, in its owner's words. */
export async function deckCatalogue(
    caller: DeckCaller,
    words: DeckWords
): Promise<DeckActionView[]> {
    const offered = (await everyAction(words, caller)).filter((action) =>
        allowed(action.scope, caller)
    );
    const listings: ToolListings = new Map();
    return Promise.all(offered.map((action) => viewOf(action, caller, words, listings)));
}

/** A run as the plugin asks for it. */
export const deckRunSchema = z.object({
    action: z.string().trim().min(1).max(80),
    options: z.record(z.unknown()).default({}),
    /** A dial's turn, in ticks: negative is anticlockwise. */
    step: z.number().int().min(-50).max(50).optional(),
    /** A dial pushed rather than turned. */
    push: z.boolean().optional()
});

export type DeckRunInput = z.infer<typeof deckRunSchema>;

/** Run one action. Unknown, not allowed and badly set all answer as a refusal
 *  in words, never by naming what is inside. */
export async function runDeckAction(
    caller: DeckCaller,
    input: DeckRunInput,
    words: DeckWords
): Promise<DeckRunResult> {
    const action = (await everyAction(words, caller, input.action.startsWith(TOOL_PREFIX))).find(
        (candidate) => candidate.id === input.action
    );
    if (!action) return { ok: false, message: words("deck.errors.unknownAction") };
    if (!allowed(action.scope, caller))
        return {
            ok: false,
            message:
                action.scope && (await reconnectable(caller)(action.scope))
                    ? reconnectMessage(action.scope, caller, words)
                    : words("deck.errors.notAllowed")
        };

    if (action.core) {
        const core = action.core;
        const options = core.options.safeParse(input.options);
        if (!options.success) return { ok: false, message: words("deck.errors.badOptions") };
        if (!core.run) return { ok: false, message: words("deck.errors.notRunnable") };
        return core.run(options.data, caller);
    }

    if (action.tool) {
        // The tool's own schema, scope and budgets decide, in callTool.
        const outcome = await callTool(
            caller,
            action.tool.tool.name,
            toolInput(action.tool, input.options)
        );
        return outcome.ok
            ? { ok: true }
            : { ok: false, message: outcome.message ?? words("deck.errors.refused") };
    }

    const app = action.app!;
    const options = app.options.safeParse(input.options);
    if (!options.success) return { ok: false, message: words("deck.errors.badOptions") };
    // A toggle flips what is there now and a dial moves from it, so both read
    // it first, through the same tool the key's state comes from.
    const raw = app.read
        ? await callTool(caller, app.read.tool, app.read.input(options.data))
        : null;
    const current =
        app.read && raw ? withPress(app, pickState(app, raw, caller), options.data, raw, caller) : undefined;
    // Already where the press would put it: nothing is sent, and the key is
    // told what it is.
    if (current?.press?.noop && !input.push) return { ok: true, state: current };
    const sent = app.run.input(options.data, {
        step: input.step,
        push: input.push,
        current,
        read: raw?.ok ? raw.structured : undefined
    });
    if (sent === null) return { ok: false, message: words("deck.errors.refused") };
    const outcome = await callTool(caller, app.run.tool, sent);
    if (!outcome.ok) return { ok: false, message: outcome.message ?? words("deck.errors.refused") };
    const after = app.read ? await readApp(app, options.data, caller) : undefined;
    return after ? { ok: true, state: after } : { ok: true };
}

async function readApp(
    app: AppDeckAction,
    options: Record<string, unknown>,
    caller: DeckCaller
): Promise<DeckState> {
    const read = app.read!;
    const outcome = await callTool(caller, read.tool, read.input(options));
    return withPress(app, pickState(app, outcome, caller), options, outcome, caller);
}

/** The state with what a press would do from it, when the action knows. */
function withPress(
    app: AppDeckAction,
    state: DeckState,
    options: Record<string, unknown>,
    outcome: Awaited<ReturnType<typeof callTool>>,
    caller: DeckCaller
): DeckState {
    const press = app.read?.press;
    if (!press || !outcome.ok) return state;
    try {
        const next = press(state, options, outcome.structured, caller.locale);
        return next ? { ...state, press: next } : state;
    } catch {
        return state;
    }
}

function pickState(
    app: AppDeckAction,
    outcome: Awaited<ReturnType<typeof callTool>>,
    caller: DeckCaller
): DeckState {
    if (!outcome.ok) return { tone: "idle" };
    try {
        return app.read!.pick(outcome.structured, caller.locale);
    } catch {
        return { tone: "idle" };
    }
}

/** One key the plugin wants the state of: its own id, the action and its
 *  settings. */
export const deckWatchSchema = z
    .array(
        z.object({
            key: z.string().trim().min(1).max(64),
            action: z.string().trim().min(1).max(80),
            options: z.record(z.unknown()).default({})
        })
    )
    .max(64);

export type DeckWatch = z.infer<typeof deckWatchSchema>;

/** Longest `watch` parameter read: 64 keys with their settings, with room. */
const WATCH_MAX = 16_384;

/** The keys a stream is asked for, from its base64url JSON parameter; null when
 *  it is not a list of them. Absent is no keys. */
export function readWatch(raw: string | null): DeckWatch | null {
    if (raw === null) return [];
    if (raw.length > WATCH_MAX) return null;
    try {
        const parsed = deckWatchSchema.safeParse(
            JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
        );
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** What each watched key shows, and which of them the chat bus wakes. */
export interface DeckReading {
    readonly key: string;
    readonly state: DeckState;
}

/** Read every watched key once. A key whose action is gone, not allowed or set
 *  wrongly reads as idle rather than failing the others. */
export async function readDeckStates(
    caller: DeckCaller,
    watched: DeckWatch,
    words: DeckWords
): Promise<{ readings: DeckReading[]; chat: boolean; call: boolean }> {
    const actions = new Map(
        (await everyAction(words, caller, false)).map((action) => [action.id, action])
    );
    let chat = false;
    let call = false;
    const may = reconnectable(caller);
    const readings = await Promise.all(
        watched.map(async (entry): Promise<DeckReading> => {
            const action = actions.get(entry.action);
            if (!action) return { key: entry.key, state: { tone: "idle" } };
            if (!allowed(action.scope, caller))
                return {
                    key: entry.key,
                    state: (await may(action.scope))
                        ? { tone: "bad", detail: words("deck.status.reconnect") }
                        : { tone: "idle" }
                };
            if (action.core?.read) {
                const options = action.core.options.safeParse(entry.options);
                if (!options.success) return { key: entry.key, state: { tone: "idle" } };
                if (action.core.wakes === "chat") chat = true;
                if (action.core.wakes === "call") call = true;
                try {
                    return { key: entry.key, state: await action.core.read(options.data, caller) };
                } catch (caught) {
                    console.error(`deck: reading ${entry.action} failed`, caught);
                    return { key: entry.key, state: { tone: "idle" } };
                }
            }
            if (action.app?.read) {
                const options = action.app.options.safeParse(entry.options);
                if (!options.success) return { key: entry.key, state: { tone: "idle" } };
                return { key: entry.key, state: await readApp(action.app, options.data, caller) };
            }
            return { key: entry.key, state: { tone: "idle" } };
        })
    );
    return { readings, chat, call };
}
