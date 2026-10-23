/**
 * The terminal UI's state, and every key's effect on it. Pure: a key or an
 * answer from Polaris goes in, the next state and what to ask Polaris for come
 * out. `run.ts` does the asking and the drawing, so everything a person can do
 * here is tested without a terminal or a network.
 *
 * The screens are a stack: profiles -> projects -> services -> one service,
 * and from the service its deployments, its log or its variables. Esc goes back
 * one; `/` filters the list on screen; `q` quits; `?` shows the keys.
 */

import type { z } from "zod";
import type {
    deploymentsSchema,
    envNamesSchema,
    projectsSchema,
    ServiceDetail
} from "../schemas.js";

export type Project = z.infer<typeof projectsSchema>["projects"][number];
export type Deployment = z.infer<typeof deploymentsSchema>["deployments"][number];
export type Variable = z.infer<typeof envNamesSchema>["variables"][number];

export interface ProfileRow {
    readonly name: string;
    readonly url: string;
    readonly account: string;
    readonly current: boolean;
}

export type Screen =
    | { readonly kind: "profiles" }
    | { readonly kind: "projects" }
    | { readonly kind: "services"; readonly projectId: string }
    | { readonly kind: "service"; readonly serviceId: string }
    | { readonly kind: "deployments"; readonly serviceId: string }
    | { readonly kind: "logs"; readonly serviceId: string }
    | { readonly kind: "env"; readonly serviceId: string };

/** What a service's screen offers, in order. */
export const SERVICE_MENU = [
    { id: "deployments", label: "Deployments" },
    { id: "logs", label: "Log (follows as it is written)" },
    { id: "env", label: "Environment variables" },
    { id: "deploy", label: "Deploy again" },
    { id: "restart", label: "Restart" }
] as const;

export type Action = "deploy" | "restart";

export interface State {
    readonly stack: readonly Screen[];
    /** The highlighted row of each screen on the stack, by depth. */
    readonly cursors: readonly number[];
    readonly filter: string;
    readonly filtering: boolean;
    readonly help: boolean;
    readonly confirm: { readonly action: Action; readonly serviceId: string } | null;
    /** A line at the bottom: what just happened, or what went wrong. */
    readonly message: { readonly text: string; readonly tone: "info" | "error" } | null;
    readonly loading: boolean;
    readonly profiles: readonly ProfileRow[];
    readonly profile: string | null;
    readonly projects: readonly Project[] | null;
    readonly service: ServiceDetail | null;
    readonly deployments: readonly Deployment[] | null;
    readonly variables: readonly Variable[] | null;
    readonly log: readonly string[];
    /** How many lines the log view is scrolled up from its end. */
    readonly scroll: number;
}

/** A key, already named by the driver. */
export type Key =
    | "up"
    | "down"
    | "enter"
    | "back"
    | "quit"
    | "help"
    | "filter"
    | "erase"
    | "refresh"
    | "deploy"
    | "restart"
    | "yes"
    | "no"
    | { readonly char: string };

export type Event =
    | { readonly type: "key"; readonly key: Key }
    | {
          readonly type: "projects";
          readonly profile: string | null;
          readonly projects: readonly Project[];
      }
    | { readonly type: "service"; readonly service: ServiceDetail }
    | {
          readonly type: "deployments";
          readonly serviceId: string;
          readonly deployments: readonly Deployment[];
      }
    | {
          readonly type: "variables";
          readonly serviceId: string;
          readonly variables: readonly Variable[];
      }
    | { readonly type: "log"; readonly text: string; readonly append: boolean }
    | { readonly type: "done"; readonly text: string }
    | { readonly type: "failed"; readonly text: string };

/** What the driver is asked to do after a step. */
export type Effect =
    | { readonly type: "use-profile"; readonly name: string }
    | { readonly type: "load-projects"; readonly profile: string | null }
    | { readonly type: "load-service"; readonly serviceId: string }
    | { readonly type: "load-deployments"; readonly serviceId: string }
    | { readonly type: "load-variables"; readonly serviceId: string }
    | { readonly type: "follow-log"; readonly serviceId: string }
    | { readonly type: "stop-log" }
    | { readonly type: "run"; readonly action: Action; readonly serviceId: string }
    | { readonly type: "quit" };

export interface Step {
    readonly state: State;
    readonly effects: readonly Effect[];
}

/** The most log lines kept; older ones scroll away. */
export const LOG_LINES = 2000;

/** Where the UI opens: the profile list when there is a choice to make, the
 *  projects otherwise. */
export function initial(profiles: readonly ProfileRow[], profile: string | null): Step {
    const choose = profile === null && profiles.length > 1;
    const state: State = {
        stack: [{ kind: choose ? "profiles" : "projects" }],
        cursors: [
            Math.max(
                0,
                profiles.findIndex((each) => each.current)
            )
        ],
        filter: "",
        filtering: false,
        help: false,
        confirm: null,
        message: null,
        loading: !choose,
        profiles,
        profile: choose ? null : (profile ?? profiles[0]?.name ?? null),
        projects: null,
        service: null,
        deployments: null,
        variables: null,
        log: [],
        scroll: 0
    };
    if (choose) return { state: { ...state, cursors: [state.cursors[0] ?? 0] }, effects: [] };
    return {
        state: { ...state, cursors: [0] },
        effects: [
            ...(state.profile ? [{ type: "use-profile" as const, name: state.profile }] : []),
            { type: "load-projects", profile: state.profile }
        ]
    };
}

export function top(state: State): Screen {
    return state.stack[state.stack.length - 1]!;
}

/** A row on a list screen: what is shown, what it is matched on, and where
 *  Enter leads. */
export interface Row {
    readonly label: string;
    readonly hint: string;
    readonly target?: Screen | { readonly kind: "action"; readonly action: Action };
    readonly profile?: string;
}

function servicesOf(state: State, projectId: string): Row[] {
    const project = state.projects?.find((each) => each.id === projectId);
    if (!project) return [];
    return project.environments.flatMap((environment) =>
        environment.services.map((service) => ({
            label: `${environment.slug}/${service.slug}`,
            hint: service.status,
            target: { kind: "service" as const, serviceId: service.id }
        }))
    );
}

/** Every row of a screen, before the filter. Empty for the log. */
export function allRows(state: State, screen: Screen = top(state)): Row[] {
    switch (screen.kind) {
        case "profiles":
            return state.profiles.map((each) => ({
                label: each.name,
                hint: `${each.url}  ${each.account}`,
                profile: each.name
            }));
        case "projects":
            return (state.projects ?? []).map((project) => ({
                label: project.name,
                hint: `${project.slug}, ${project.environments.reduce((sum, each) => sum + each.services.length, 0)} service(s)`,
                target: { kind: "services", projectId: project.id }
            }));
        case "services":
            return servicesOf(state, screen.projectId);
        case "service":
            return SERVICE_MENU.map((item) => ({
                label: item.label,
                hint: "",
                target:
                    item.id === "deploy" || item.id === "restart"
                        ? { kind: "action", action: item.id }
                        : { kind: item.id, serviceId: screen.serviceId }
            }));
        case "deployments":
            return (state.deployments ?? []).map((entry) => ({
                label: entry.id,
                hint: [
                    entry.isCurrent ? `${entry.status} (current)` : entry.status,
                    entry.createdAt,
                    entry.commitSha?.slice(0, 7) ?? "",
                    (entry.commitMessage ?? "").split(/\r?\n/)[0] ?? ""
                ]
                    .filter(Boolean)
                    .join("  ")
            }));
        case "env":
            // Values are never sent to the CLI; a secret is shown masked so a
            // glance tells it from a plain one.
            return (state.variables ?? []).map((variable) => ({
                label: variable.key,
                hint: `${variable.isSecret ? "secret  ******" : "plain   (value not shown)"}  ${variable.updatedAt}`
            }));
        case "logs":
            return [];
    }
}

/** The rows the filter leaves. */
export function rows(state: State): Row[] {
    const needle = state.filter.trim().toLowerCase();
    const every = allRows(state);
    if (!needle) return every;
    return every.filter((row) => `${row.label} ${row.hint}`.toLowerCase().includes(needle));
}

function cursor(state: State): number {
    return state.cursors[state.stack.length - 1] ?? 0;
}

function withCursor(state: State, value: number): State {
    const cursors = [...state.cursors];
    cursors[state.stack.length - 1] = value;
    return { ...state, cursors };
}

/** What has to be read for a screen when it is opened. */
function loadsFor(state: State, screen: Screen): Effect[] {
    switch (screen.kind) {
        case "projects":
            return [{ type: "load-projects", profile: state.profile }];
        case "service":
            return [{ type: "load-service", serviceId: screen.serviceId }];
        case "deployments":
            return [{ type: "load-deployments", serviceId: screen.serviceId }];
        case "env":
            return [{ type: "load-variables", serviceId: screen.serviceId }];
        case "logs":
            return [{ type: "follow-log", serviceId: screen.serviceId }];
        default:
            return [];
    }
}

function push(state: State, screen: Screen): Step {
    const next: State = {
        ...state,
        stack: [...state.stack, screen],
        cursors: [...state.cursors.slice(0, state.stack.length), 0],
        filter: "",
        filtering: false,
        message: null,
        loading: loadsFor(state, screen).length > 0,
        // What another service left behind is not shown as this one's.
        ...(screen.kind === "logs" ? { log: [], scroll: 0 } : {}),
        ...(screen.kind === "deployments" ? { deployments: null } : {}),
        ...(screen.kind === "env" ? { variables: null } : {}),
        ...(screen.kind === "service" && state.service?.id !== screen.serviceId
            ? { service: null }
            : {})
    };
    return { state: next, effects: loadsFor(next, screen) };
}

function back(state: State): Step {
    const leaving = top(state);
    const stop: Effect[] = leaving.kind === "logs" ? [{ type: "stop-log" }] : [];
    if (state.stack.length === 1) {
        // Back from the first screen: to the profiles when there is a choice.
        if (leaving.kind === "projects" && state.profiles.length > 1) {
            return {
                state: {
                    ...state,
                    stack: [{ kind: "profiles" }],
                    cursors: [
                        Math.max(
                            0,
                            state.profiles.findIndex((p) => p.name === state.profile)
                        )
                    ],
                    filter: "",
                    message: null,
                    loading: false
                },
                effects: stop
            };
        }
        return { state, effects: stop };
    }
    const next: State = {
        ...state,
        stack: state.stack.slice(0, -1),
        cursors: state.cursors.slice(0, state.stack.length - 1),
        filter: "",
        filtering: false,
        message: null,
        loading: false
    };
    return { state: next, effects: stop };
}

function serviceOf(screen: Screen): string | null {
    return "serviceId" in screen ? screen.serviceId : null;
}

function showing(state: State, kind: Screen["kind"], serviceId: string): boolean {
    return state.stack.some((each) => each.kind === kind && serviceOf(each) === serviceId);
}

function onKey(state: State, key: Key): Step {
    const same: Step = { state, effects: [] };

    if (state.confirm) {
        if (key === "yes") {
            const { action, serviceId } = state.confirm;
            return {
                state: {
                    ...state,
                    confirm: null,
                    loading: true,
                    message: {
                        text: action === "deploy" ? "Starting a deployment..." : "Restarting...",
                        tone: "info"
                    }
                },
                effects: [{ type: "run", action, serviceId }]
            };
        }
        if (key === "quit")
            return { state: { ...state, confirm: null }, effects: [{ type: "quit" }] };
        if (key === "no" || key === "back")
            return { state: { ...state, confirm: null, message: null }, effects: [] };
        return same;
    }

    if (state.help) return { state: { ...state, help: false }, effects: [] };

    if (state.filtering) {
        if (typeof key === "object")
            return {
                state: withCursor({ ...state, filter: state.filter + key.char }, 0),
                effects: []
            };
        if (key === "erase")
            return {
                state: withCursor({ ...state, filter: state.filter.slice(0, -1) }, 0),
                effects: []
            };
        if (key === "back")
            return { state: { ...state, filtering: false, filter: "" }, effects: [] };
        if (key === "enter") return { state: { ...state, filtering: false }, effects: [] };
        if (key !== "up" && key !== "down") return same;
    }

    const screen = top(state);
    const list = rows(state);
    const at = Math.min(cursor(state), Math.max(0, list.length - 1));

    switch (key) {
        case "quit":
            return { state, effects: [{ type: "quit" }] };
        case "help":
            return { state: { ...state, help: true }, effects: [] };
        case "filter":
            return screen.kind === "logs"
                ? same
                : { state: { ...state, filtering: true }, effects: [] };
        case "back":
        case "erase":
            if (state.filter)
                return { state: withCursor({ ...state, filter: "" }, 0), effects: [] };
            return back(state);
        case "up":
            if (screen.kind === "logs")
                return {
                    state: {
                        ...state,
                        scroll: Math.min(state.scroll + 1, Math.max(0, state.log.length - 1))
                    },
                    effects: []
                };
            return { state: withCursor(state, Math.max(0, at - 1)), effects: [] };
        case "down":
            if (screen.kind === "logs")
                return { state: { ...state, scroll: Math.max(0, state.scroll - 1) }, effects: [] };
            return {
                state: withCursor(state, Math.min(Math.max(0, list.length - 1), at + 1)),
                effects: []
            };
        case "refresh":
            return {
                state: { ...state, loading: loadsFor(state, screen).length > 0, message: null },
                effects: loadsFor(state, screen)
            };
        case "deploy":
        case "restart": {
            const serviceId = serviceOf(screen);
            if (!serviceId) return same;
            return { state: { ...state, confirm: { action: key, serviceId } }, effects: [] };
        }
        case "enter": {
            const row = list[at];
            if (!row) return same;
            if (row.profile) {
                const step = push(
                    { ...state, stack: [], cursors: [], profile: row.profile, projects: null },
                    { kind: "projects" }
                );
                return {
                    state: step.state,
                    effects: [{ type: "use-profile", name: row.profile }, ...step.effects]
                };
            }
            if (!row.target) return same;
            if (row.target.kind === "action") {
                const serviceId = serviceOf(screen);
                return serviceId
                    ? {
                          state: { ...state, confirm: { action: row.target.action, serviceId } },
                          effects: []
                      }
                    : same;
            }
            return push(withCursor(state, at), row.target);
        }
        default:
            return same;
    }
}

/** One step: a key pressed, or an answer from Polaris. */
export function reduce(state: State, event: Event): Step {
    switch (event.type) {
        case "key":
            return onKey(state, event.key);
        case "projects":
            // An answer for a profile already left behind is dropped.
            if (event.profile !== state.profile) return { state, effects: [] };
            return { state: { ...state, projects: event.projects, loading: false }, effects: [] };
        case "service":
            // An answer for a service already left behind is dropped.
            if (!state.stack.some((each) => serviceOf(each) === event.service.id))
                return { state, effects: [] };
            return { state: { ...state, service: event.service, loading: false }, effects: [] };
        case "deployments":
            if (!showing(state, "deployments", event.serviceId)) return { state, effects: [] };
            return {
                state: { ...state, deployments: event.deployments, loading: false },
                effects: []
            };
        case "variables":
            if (!showing(state, "env", event.serviceId)) return { state, effects: [] };
            return { state: { ...state, variables: event.variables, loading: false }, effects: [] };
        case "log": {
            const incoming = event.text
                .split(/\r?\n/)
                .filter((each, index, all) => each !== "" || index < all.length - 1);
            const log = (event.append ? [...state.log, ...incoming] : incoming).slice(-LOG_LINES);
            return { state: { ...state, log, loading: false }, effects: [] };
        }
        case "done": {
            const screen = top(state);
            return {
                state: { ...state, loading: false, message: { text: event.text, tone: "info" } },
                effects:
                    screen.kind === "service" || screen.kind === "deployments"
                        ? loadsFor(state, screen)
                        : []
            };
        }
        case "failed":
            return {
                state: { ...state, loading: false, message: { text: event.text, tone: "error" } },
                effects: []
            };
    }
}

/** A key as the terminal reports it (Node's keypress), named for `reduce`.
 *  While filtering, letters are text; otherwise they are commands. */
export function nameKey(
    state: State,
    text: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined
): Key | null {
    const name = key?.name;
    if (key?.ctrl && (name === "c" || name === "d")) return "quit";
    if (name === "up") return "up";
    if (name === "down") return "down";
    if (name === "return" || name === "enter") return "enter";
    if (name === "escape") return "back";
    if (name === "backspace" || name === "delete") return state.filtering ? "erase" : "back";
    if (key?.ctrl || key?.meta || !text || text.length !== 1 || text < " ") return null;
    if (state.filtering) return { char: text };
    if (state.confirm) return text === "y" || text === "Y" ? "yes" : "no";
    const commands: Record<string, Key> = {
        k: "up",
        j: "down",
        l: "enter",
        h: "back",
        q: "quit",
        "?": "help",
        "/": "filter",
        d: "deploy",
        r: "restart",
        u: "refresh"
    };
    return commands[text] ?? null;
}

export interface RawKey {
    readonly text?: string;
    readonly name?: string;
    readonly ctrl?: boolean;
}

const SEQUENCES: Readonly<Record<string, RawKey>> = {
    "\u001b[A": { name: "up" },
    "\u001bOA": { name: "up" },
    "\u001b[B": { name: "down" },
    "\u001bOB": { name: "down" },
    "\u001b[3~": { name: "delete" }
};

/**
 * A chunk read from the terminal, as keys. Read here rather than with Node's
 * keypress events, which hold a lone Esc until the next key arrives - so Esc
 * would do nothing until something else was pressed.
 */
export function parseKeys(chunk: string): RawKey[] {
    const keys: RawKey[] = [];
    let at = 0;
    while (at < chunk.length) {
        const rest = chunk.slice(at);
        const sequence = Object.keys(SEQUENCES).find((each) => rest.startsWith(each));
        if (sequence) {
            keys.push(SEQUENCES[sequence]!);
            at += sequence.length;
            continue;
        }
        // Any other escape sequence (Home, F1, a paste marker) is not a key here.
        const other = /^\u001b(\[[0-9;?]*[@-~]|O.)/.exec(rest);
        if (other) {
            at += other[0].length;
            continue;
        }
        const char = rest[0]!;
        at += 1;
        if (char === "\u001b") keys.push({ name: "escape" });
        else if (char === "\r" || char === "\n") {
            keys.push({ name: "return" });
            if (char === "\r" && rest[1] === "\n") at += 1;
        } else if (char === "\u007f" || char === "\b") keys.push({ name: "backspace" });
        else if (char === "\u0003") keys.push({ name: "c", ctrl: true });
        else if (char === "\u0004") keys.push({ name: "d", ctrl: true });
        else if (char >= " ") keys.push({ text: char });
    }
    return keys;
}
