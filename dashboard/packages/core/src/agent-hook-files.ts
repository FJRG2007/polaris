// Ported from backend/internal/adapters/agent/hooksjson/hooksjson.go and each
// agent's backend/internal/adapters/agent/<name>/hooks.go in Agent Orchestrator
// (Apache-2.0, github.com/OrchestratorInc/agent-orchestrator, commit e4ded08c6f15).

import type { AgentFirstRunAnswer, AgentFirstRunValue } from "./agent-clis.js";

/**
 * The one command every tool's hook configuration runs.
 *
 * Fixed text, and the same in every home: a container home is shared by every
 * session that account runs, so a hook naming one session's script would report
 * every other session's events as that one's. The session it belongs to is
 * whichever exported `POLARIS_STATE_DIR` into the agent's environment, and a
 * tool started anywhere else - the sign-in container, a terminal somebody
 * opened by hand - finds no script and reports nothing.
 *
 * It prints `{}` either way: Codex and Gemini CLI read a hook's output as JSON,
 * and an empty object is the answer that changes nothing.
 */
export const AGENT_HOOK_RELAY =
    'h="$POLARIS_STATE_DIR/hook.sh"; if [ -n "$POLARIS_STATE_DIR" ] && [ -x "$h" ]; then exec "$h"; fi; cat >/dev/null; printf "{}"';

/**
 * The placeholder a hook file's path starts with when the tool reads it from
 * the checkout rather than from its home. Replaced with the session's worktree
 * when the file is written; such a file is kept out of the repository's
 * commits (see `firstRunProgram`).
 */
export const HOOK_FILE_WORKDIR = "{workdir}/";

/** The lines around the block Polaris keeps in a file it does not own whole
 *  (`AgentFirstRunAnswer.block`). */
export const HOOK_BLOCK_START = "# polaris: managed hooks";
export const HOOK_BLOCK_END = "# /polaris: managed hooks";

/**
 * What a hook says happened, in one vocabulary for every tool: the sub-command
 * names Agent Orchestrator's own `ao hooks <agent> <signal>` callbacks use.
 * Each tool's native event is registered under one of these.
 */
export const HOOK_SIGNALS = [
    "session-start",
    "user-prompt-submit",
    "pre-invocation",
    "pre-tool-use",
    "post-tool-use",
    "post-tool-use-failure",
    "permission-request",
    "permission-resolved",
    "notification",
    "stop",
    "stop-failure",
    "session-end"
] as const;
export type HookSignal = (typeof HOOK_SIGNALS)[number];

/**
 * The event name each signal reaches Polaris under.
 *
 * Claude Code's names, because that is the vocabulary the session's event
 * reader already speaks: a tool whose native payload uses other names (or none)
 * is registered with `POLARIS_HOOK_EVENT` set to one of these, and the hook
 * script stamps it on the payload. Letters only, which is all the script lets
 * through.
 */
export const HOOK_SIGNAL_EVENTS: Readonly<Record<HookSignal, string>> = {
    "session-start": "SessionStart",
    "user-prompt-submit": "UserPromptSubmit",
    "pre-invocation": "PreInvocation",
    "pre-tool-use": "PreToolUse",
    "post-tool-use": "PostToolUse",
    "post-tool-use-failure": "PostToolUseFailure",
    "permission-request": "PermissionRequest",
    "permission-resolved": "PermissionResolved",
    notification: "Notification",
    stop: "Stop",
    "stop-failure": "StopFailure",
    "session-end": "SessionEnd"
};

/** The signal an event name stands for, the reverse of `HOOK_SIGNAL_EVENTS`. */
export function hookSignalOf(event: string): HookSignal | null {
    for (const signal of HOOK_SIGNALS) if (HOOK_SIGNAL_EVENTS[signal] === event) return signal;
    return null;
}

/**
 * How a tool lays its hook file out.
 *
 * - `matcher`: `{ hooks: { <Event>: [{ matcher?, hooks: [{ type, command, timeout }] }] } }`,
 *   Claude Code's shape, shared by most of them (`hooksjson.Manager`).
 * - `cursor`: `{ version: 1, hooks: { <event>: [{ command }] } }`.
 * - `named`: one top-level entry of Polaris's own holding the events
 *   (Antigravity's `.agents/hooks.json`).
 * - `list`: `{ hooks: { enabled: true, hooks: [{ event, command, ... }] } }`
 *   (Autohand's `config.json`).
 */
export type HookFileLayout = "matcher" | "cursor" | "named" | "list";

export interface HookRegistration {
    /** The tool's own name for the event. */
    readonly event: string;
    readonly signal: HookSignal;
    /** Matcher-group filter, where the tool's file takes one. */
    readonly matcher?: string;
    /** For `named`: register as a matcher group rather than a bare entry. */
    readonly grouped?: boolean;
}

export interface HookFileSpec {
    /** Relative to the home, or to the worktree when it starts with
     *  `HOOK_FILE_WORKDIR`. */
    readonly file: string;
    readonly layout: HookFileLayout;
    /** In the tool's own unit, which is not always seconds. */
    readonly timeout: number;
    readonly events: readonly HookRegistration[];
}

const w = (path: string): string => `${HOOK_FILE_WORKDIR}${path}`;

const SESSION_START: HookRegistration = { event: "SessionStart", signal: "session-start" };
const PROMPT: HookRegistration = { event: "UserPromptSubmit", signal: "user-prompt-submit" };
const STOP: HookRegistration = { event: "Stop", signal: "stop" };
const SESSION_END: HookRegistration = { event: "SessionEnd", signal: "session-end" };

/**
 * Every tool whose hook file is written from this table, by catalogue id.
 *
 * Files, events, matchers and timeouts as Agent Orchestrator registers them for
 * the same tool (`adapters/agent/<name>/hooks.go`), including where the file
 * lives: in the checkout where it writes one there, in the home where it does.
 * A tool that is not here is either one of the three written in `agent-clis.ts`
 * (Codex, Gemini CLI, Copilot) or one whose hooks are not a JSON file Polaris
 * can write yet - see `U3-PLAN.md`.
 */
export const AGENT_HOOK_FILES: Readonly<Record<string, HookFileSpec>> = {
    qwen: {
        file: w(".qwen/settings.json"),
        layout: "matcher",
        timeout: 30000,
        events: [
            { ...SESSION_START, matcher: "startup|resume" },
            PROMPT,
            { event: "PermissionRequest", signal: "permission-request" },
            STOP
        ]
    },
    goose: {
        file: w(".agents/plugins/polaris/hooks/hooks.json"),
        layout: "matcher",
        timeout: 30,
        events: [SESSION_START, PROMPT, STOP]
    },
    droid: {
        file: w(".factory/hooks.json"),
        layout: "matcher",
        timeout: 30,
        events: [
            { ...SESSION_START, matcher: "startup" },
            PROMPT,
            STOP,
            { event: "Notification", signal: "notification" },
            SESSION_END
        ]
    },
    openhands: {
        file: w(".openhands/hooks.json"),
        layout: "matcher",
        timeout: 30,
        events: [SESSION_START, PROMPT, STOP]
    },
    kimchi: {
        file: w(".kimchi/hooks.local.json"),
        layout: "matcher",
        timeout: 30,
        events: [
            { ...SESSION_START, matcher: "startup" },
            PROMPT,
            STOP,
            { event: "Notification", signal: "notification" },
            SESSION_END,
            { event: "PreToolUse", signal: "pre-tool-use" },
            { event: "PostToolUse", signal: "post-tool-use" },
            { event: "PostToolUseFail", signal: "post-tool-use-failure" }
        ]
    },
    devin: {
        file: w(".devin/config.local.json"),
        layout: "matcher",
        timeout: 30,
        events: [SESSION_START, PROMPT, STOP, SESSION_END]
    },
    "command-code": {
        file: w(".commandcode/settings.json"),
        layout: "matcher",
        timeout: 30,
        events: [
            SESSION_START,
            { event: "PreToolUse", signal: "pre-tool-use" },
            { event: "PostToolUse", signal: "post-tool-use" },
            STOP
        ]
    },
    cursor: {
        file: w(".cursor/hooks.json"),
        layout: "cursor",
        timeout: 0,
        // Not `beforeShellExecution` / `beforeMCPExecution`: those are fail-closed
        // permission gates whose answer decides whether the command runs, and
        // Polaris only listens.
        events: [
            { event: "sessionStart", signal: "session-start" },
            { event: "beforeSubmitPrompt", signal: "user-prompt-submit" },
            { event: "stop", signal: "stop" },
            { event: "afterShellExecution", signal: "post-tool-use" },
            { event: "afterMCPExecution", signal: "post-tool-use" },
            { event: "postToolUse", signal: "post-tool-use" },
            { event: "postToolUseFailure", signal: "post-tool-use-failure" }
        ]
    },
    agy: {
        file: w(".agents/hooks.json"),
        layout: "named",
        timeout: 30,
        events: [
            { event: "PreInvocation", signal: "pre-invocation" },
            { event: "PostToolUse", signal: "post-tool-use", matcher: "*", grouped: true },
            STOP
        ]
    },
    autohand: {
        // Autohand reads hooks from its home configuration only.
        file: ".autohand/config.json",
        layout: "list",
        timeout: 30,
        events: [
            { event: "session-start", signal: "session-start" },
            { event: "pre-prompt", signal: "user-prompt-submit" },
            { event: "permission-request", signal: "permission-request" },
            { event: "stop", signal: "stop" }
        ]
    }
};

/** The command one registration runs: the relay, told which event it is. */
export function hookCommand(signal: HookSignal): string {
    return `export POLARIS_HOOK_EVENT=${HOOK_SIGNAL_EVENTS[signal]}; ${AGENT_HOOK_RELAY}`;
}

/**
 * One matcher group, the unit of Claude Code's hook shape: shared by Claude
 * Code's own settings, Codex, Gemini CLI and every `matcher` file above.
 */
export function hookGroup(
    command: string,
    timeout: number,
    { matcher, extra }: { matcher?: string | null; extra?: Record<string, AgentFirstRunValue> } = {}
): Record<string, AgentFirstRunValue> {
    const hook: Record<string, AgentFirstRunValue> = { ...extra, type: "command", command };
    if (timeout) hook.timeout = timeout;
    return matcher ? { matcher, hooks: [hook] } : { hooks: [hook] };
}

/** The keys a tool's hook file has to hold, by its layout. */
export function renderHookFile(spec: HookFileSpec): Record<string, AgentFirstRunValue> {
    const byEvent = new Map<string, HookRegistration[]>();
    for (const registration of spec.events) {
        byEvent.set(registration.event, [...(byEvent.get(registration.event) ?? []), registration]);
    }
    switch (spec.layout) {
        case "matcher": {
            const hooks: Record<string, AgentFirstRunValue> = {};
            for (const [event, registrations] of byEvent) {
                hooks[event] = registrations.map((r) =>
                    hookGroup(hookCommand(r.signal), spec.timeout, { matcher: r.matcher })
                );
            }
            return { hooks };
        }
        case "cursor": {
            const hooks: Record<string, AgentFirstRunValue> = {};
            for (const [event, registrations] of byEvent) {
                hooks[event] = registrations.map((r) => ({ command: hookCommand(r.signal) }));
            }
            return { hooks };
        }
        case "named": {
            const named: Record<string, AgentFirstRunValue> = {};
            for (const [event, registrations] of byEvent) {
                named[event] = registrations.map((r) => {
                    const entry = { type: "command", command: hookCommand(r.signal), timeout: spec.timeout };
                    return r.grouped ? { ...(r.matcher ? { matcher: r.matcher } : {}), hooks: [entry] } : entry;
                });
            }
            return { polaris: named };
        }
        case "list":
            return {
                hooks: {
                    enabled: true,
                    hooks: spec.events.map((r) => ({
                        event: r.event,
                        command: hookCommand(r.signal),
                        description: "Polaris session status",
                        enabled: true,
                        timeout: spec.timeout
                    }))
                }
            };
    }
}

/**
 * The first-run answer that writes a tool's hook file, or null for a tool this
 * table does not cover. Hooks are asserted - they are Polaris's to keep in a
 * home or checkout it set up - and a list asserted this way keeps whatever
 * entries Polaris did not write (see `firstRunProgram`), so a repository's own
 * hooks for the same event still run.
 */
export function hookFileAnswer(cliId: string): AgentFirstRunAnswer | null {
    const spec = AGENT_HOOK_FILES[cliId];
    if (!spec) return null;
    return {
        file: spec.file,
        assert: renderHookFile(spec),
        ...(spec.layout === "cursor" ? { json: { version: 1 } } : {})
    };
}

/**
 * The first-run answers that hook a tool up: its JSON hook file from
 * `AGENT_HOOK_FILES`, or the scripts, TOML blocks and plugins of
 * `AGENT_HOOK_WRITERS`. Empty for a tool Polaris cannot hear from yet.
 */
export function hookFileAnswers(cliId: string): AgentFirstRunAnswer[] {
    const answer = hookFileAnswer(cliId);
    if (answer) return [answer];
    return AGENT_HOOK_WRITERS[cliId]?.() ?? [];
}

/**
 * A TOML basic string. Every escape a JSON string literal uses (`\"`, `\\`,
 * `\n`, `\uXXXX`) is also a TOML basic-string escape, so one is the other.
 */
export function tomlString(value: string): string {
    return JSON.stringify(value);
}

/** One `[[hooks]]` table, keys in the order given. */
export function tomlHookTable(fields: ReadonlyArray<readonly [string, string | number]>): string {
    const lines = fields.map(
        ([key, value]) => `${key} = ${typeof value === "number" ? String(value) : tomlString(value)}`
    );
    return `[[hooks]]\n${lines.join("\n")}\n`;
}

/**
 * The relay as a script of its own, for a tool that runs a hook by path rather
 * than as a shell command (Auggie).
 */
export function hookRelayScript(signal: HookSignal): string {
    return `#!/bin/sh\n# Written by Polaris: reports this session's activity.\n${hookCommand(signal)}\nexit 0\n`;
}

const AUGGIE_HOOKS_DIR = ".augment/polaris-hooks/";

/** Ported from adapters/agent/auggie/hooks.go. */
function auggieAnswers(): AgentFirstRunAnswer[] {
    const events: ReadonlyArray<readonly [string, HookSignal]> = [
        ["SessionStart", "session-start"],
        ["PreToolUse", "pre-tool-use"],
        ["PostToolUse", "post-tool-use"],
        ["Stop", "stop"],
        ["SessionEnd", "session-end"]
    ];
    const scripts: AgentFirstRunAnswer[] = events.map(([, signal]) => ({
        file: w(`${AUGGIE_HOOKS_DIR}${signal}`),
        text: hookRelayScript(signal),
        executable: true
    }));
    // The command is the script's path: a string value starting with
    // `{workdir}/` is written with the session's worktree in its place.
    const hooks: Record<string, AgentFirstRunValue> = {};
    for (const [event, signal] of events) hooks[event] = [hookGroup(w(`${AUGGIE_HOOKS_DIR}${signal}`), 5000)];
    return [...scripts, { file: w(".augment/settings.local.json"), assert: { hooks } }];
}

/** Ported from adapters/agent/kimi/hooks.go (`kimiHooksConfigBlock`). */
function kimiAnswers(): AgentFirstRunAnswer[] {
    const events: ReadonlyArray<readonly [string, HookSignal, string?]> = [
        ["SessionStart", "session-start", "startup"],
        ["UserPromptSubmit", "user-prompt-submit"],
        ["PreToolUse", "pre-tool-use"],
        ["PostToolUse", "post-tool-use"],
        ["PostToolUseFailure", "post-tool-use-failure"],
        ["PermissionRequest", "permission-request"],
        ["PermissionResult", "permission-resolved"],
        ["Stop", "stop"]
    ];
    const block = events
        .map(([event, signal, matcher]) =>
            tomlHookTable([
                ["event", event],
                ...(matcher ? ([["matcher", matcher]] as const) : []),
                ["command", hookCommand(signal)],
                ["timeout", 5]
            ])
        )
        .join("\n");
    // Kimi Code's home configuration (`KIMI_CODE_HOME`, by default `~/.kimi-code`).
    return [{ file: ".kimi-code/config.toml", block }];
}

/** Ported from adapters/agent/vibe/hooks.go (`vibeHooksBlock`). */
function vibeAnswers(): AgentFirstRunAnswer[] {
    const entries: ReadonlyArray<readonly [string, string, HookSignal, string?]> = [
        ["polaris-post-agent", "post_agent", "stop"],
        ["polaris-pre-tool", "pre_tool", "pre-tool-use", "*"],
        ["polaris-post-tool", "post_tool", "post-tool-use", "*"]
    ];
    const block = entries
        .map(([name, type, signal, match]) =>
            tomlHookTable([
                ["name", name],
                ["type", type],
                ...(match ? ([["match", match]] as const) : []),
                ["command", hookCommand(signal)],
                ["timeout", 30]
            ])
        )
        .join("\n");
    return [{ file: w(".vibe/hooks.toml"), block }];
}

/**
 * The lines every plugin starts with: `report(event, payload)` runs the relay
 * with the payload on its standard input, as a hook command would. An argument
 * array and no shell line built from data: the relay is fixed text and the
 * event travels in the environment.
 */
function pluginPrelude(): string {
    return [
        "// Written by Polaris: reports this session's activity. Rewritten on every session start.",
        'import { spawnSync } from "node:child_process";',
        "",
        `const RELAY = ${JSON.stringify(AGENT_HOOK_RELAY)};`,
        "",
        "function report(event: string, payload: Record<string, unknown>): void {",
        "    try {",
        '        spawnSync("sh", ["-c", RELAY], {',
        '            input: JSON.stringify(payload) + "\\n",',
        "            env: { ...process.env, POLARIS_HOOK_EVENT: event },",
        '            stdio: ["pipe", "ignore", "ignore"],',
        "            timeout: 10_000,",
        "            windowsHide: true",
        "        });",
        "    } catch {",
        "        // Reporting is best effort and never interrupts the agent.",
        "    }",
        "}",
        ""
    ].join("\n");
}

const E = HOOK_SIGNAL_EVENTS;
const q = (value: string): string => JSON.stringify(value);

/**
 * The OpenCode-family plugin (OpenCode, Kilo Code, MiMo Code): one session at a
 * time, a prompt reported once per message, child sessions (subagents) left
 * out. Ported from adapters/agent/opencode/assets/ao-activity.ts and its Kilo
 * Code and MiMo Code copies.
 */
export function opencodeActivityPlugin(exportLine: string): string {
    return `${pluginPrelude()}
let currentSession: string | null = null;
const childSessions = new Set<string>();
const prompted = new Map<string, boolean>();
const userMessages = new Map<string, any>();

function sessionOf(value: any): string | null {
    const id = value?.sessionID ?? value?.sessionId ?? value?.session_id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
}

function reportable(id: string | null): string | null {
    if (!id) return currentSession;
    if (!childSessions.has(id)) return id;
    return currentSession && !childSessions.has(currentSession) ? currentSession : null;
}

function switchTo(id: string): void {
    if (currentSession === id) return;
    currentSession = id;
    prompted.clear();
    userMessages.clear();
    report(${q(E["session-start"])}, { session_id: id });
}

function prompt(id: string, messageID: string, text: string): void {
    const before = prompted.get(messageID);
    if (before || (before === false && !text)) return;
    prompted.set(messageID, text.length > 0);
    report(${q(E["user-prompt-submit"])}, { session_id: id, prompt: text });
}

const hooks = {
    event: async ({ event }: any) => {
        try {
            const props = event?.properties ?? {};
            switch (event?.type) {
                case "session.created": {
                    const info = props.info;
                    if (!info?.id) break;
                    if (info.parentID) childSessions.add(info.id);
                    else switchTo(info.id);
                    break;
                }
                case "message.updated": {
                    const message = props.info;
                    const id = sessionOf(message);
                    if (!message || (id && childSessions.has(id))) break;
                    if (id) switchTo(id);
                    if (message.role === "user") {
                        userMessages.set(message.id, message);
                        const target = id ?? currentSession;
                        if (target) prompt(target, message.id, "");
                    }
                    break;
                }
                case "message.part.updated": {
                    const part = props.part;
                    const message = part?.messageID ? userMessages.get(part.messageID) : undefined;
                    if (message && part.type === "text") {
                        const target = sessionOf(message) ?? currentSession;
                        if (target) prompt(target, message.id, part.text ?? "");
                        if (part.text) userMessages.delete(part.messageID);
                    }
                    break;
                }
                case "session.status": {
                    if (props.status?.type !== "idle") break;
                    const id = props.sessionID ?? currentSession;
                    if (id && !childSessions.has(id)) report(${q(E.stop)}, { session_id: id });
                    break;
                }
                case "permission.asked":
                case "question.asked": {
                    const id = reportable(props.sessionID ?? null);
                    if (id) report(${q(E["permission-request"])}, { session_id: id });
                    break;
                }
                case "permission.replied":
                case "question.replied":
                case "question.rejected": {
                    const id = reportable(props.sessionID ?? null);
                    if (id) report(${q(E["permission-resolved"])}, { session_id: id });
                    break;
                }
            }
        } catch {
            // A malformed event never reaches the agent.
        }
    },
    "tool.execute.before": async (input: any) => {
        const id = reportable(sessionOf(input));
        if (id) report(${q(E["pre-tool-use"])}, { session_id: id, tool_name: input?.tool ?? "" });
    },
    "tool.execute.after": async (input: any) => {
        const id = reportable(sessionOf(input));
        if (id) report(${q(E["post-tool-use"])}, { session_id: id, tool_name: input?.tool ?? "" });
    }
};

${exportLine}
`;
}

/**
 * The Pi-family extension (Pi, Oh My Pi, Prime Agent), loaded with
 * `--extension` (see `hookArgs`). Ported from the extension sources in
 * adapters/agent/pi/hooks.go, adapters/agent/omp/hooks.go and
 * adapters/agent/primeagent/assets/ao-activity.ts.
 */
export function piActivityExtension(withApprovals: boolean): string {
    const approvals = withApprovals
        ? `
    api.on("tool_approval_requested", async (event: any, ctx: any) => {
        report(${q(E["permission-request"])}, { session_id: sessionOf(ctx), tool_name: event?.toolName ?? "" });
    });
    api.on("tool_approval_resolved", async (event: any, ctx: any) => {
        report(${q(E["permission-resolved"])}, { session_id: sessionOf(ctx), tool_name: event?.toolName ?? "" });
    });`
        : "";
    return `${pluginPrelude()}
function sessionOf(ctx: any): string {
    try {
        const id = ctx?.sessionManager?.getSessionId?.();
        return typeof id === "string" ? id : "";
    } catch {
        return "";
    }
}

export default function (api: any) {
    api.on("session_start", async (_event: any, ctx: any) => {
        report(${q(E["session-start"])}, { session_id: sessionOf(ctx) });
    });
    api.on("before_agent_start", async (event: any, ctx: any) => {
        report(${q(E["user-prompt-submit"])}, {
            session_id: sessionOf(ctx),
            prompt: typeof event?.prompt === "string" ? event.prompt : ""
        });
    });${approvals}
    api.on("agent_end", async (event: any, ctx: any) => {
        // A run that is about to continue on its own has not stopped.
        if (event?.willContinue) return;
        report(${q(E.stop)}, { session_id: sessionOf(ctx) });
    });
    api.on("session_shutdown", async (event: any, ctx: any) => {
        if (event?.reason && event.reason !== "quit") return;
        report(${q(E["session-end"])}, { session_id: sessionOf(ctx), reason: event?.reason ?? "" });
    });
}
`;
}

/**
 * Amp's plugin: the active thread's state as it changes, and its turns. Ported
 * from the activity half of `ampSystemPromptPluginSource` in
 * adapters/agent/amp/hooks.go (the system-prompt half is not Polaris's).
 */
export function ampActivityPlugin(): string {
    return `${pluginPrelude()}
const STATE_EVENTS: Record<string, string> = {
    running: ${q(E["pre-tool-use"])},
    idle: ${q(E.stop)},
    "awaiting-approval": ${q(E["permission-request"])}
};
let watched = "";
let subscription: { unsubscribe(): void } | null = null;

function onState(amp: any, threadID: string, state: string): void {
    if (amp.activeThread?.current?.id !== threadID || threadID !== watched) return;
    const event = STATE_EVENTS[state];
    if (event) report(event, { session_id: threadID, state });
}

function watch(amp: any, thread: any): void {
    if (!thread?.id || amp.activeThread?.current?.id !== thread.id || watched === thread.id) return;
    subscription?.unsubscribe();
    watched = thread.id;
    subscription = thread.state.subscribe((state: string) => onState(amp, thread.id, state));
    void Promise.resolve(thread.state.get?.())
        .then((state: string) => onState(amp, thread.id, state))
        .catch(() => {});
}

export default function (amp: any) {
    amp.on("session.start", async (event: any, ctx: any) => {
        watch(amp, ctx?.thread);
        if (event?.thread?.id === amp.activeThread?.current?.id)
            report(${q(E["session-start"])}, { session_id: event.thread.id });
    });
    amp.on("agent.start", async (event: any, ctx: any) => {
        watch(amp, ctx?.thread);
        if (event?.thread?.id === amp.activeThread?.current?.id)
            report(${q(E["user-prompt-submit"])}, {
                session_id: event.thread.id,
                prompt: typeof event.message === "string" ? event.message : ""
            });
        return {};
    });
    amp.on("agent.end", async (event: any) => {
        if (event?.thread?.id === amp.activeThread?.current?.id && event.thread.id === watched)
            report(${q(E.stop)}, { session_id: event.thread.id, status: event?.status ?? "" });
    });
}
`;
}

const OPENCODE_EXPORT = "export const PolarisActivity = async () => hooks;";

/**
 * Every tool whose hooks are something other than one JSON file, by catalogue
 * id: relay scripts, a TOML block, a plugin the tool loads. Paths as Agent
 * Orchestrator writes them for the same tool, named for Polaris. The Pi
 * family's extensions sit where the tool does not discover them on its own,
 * since `hookArgs` loads them by path and one loaded twice reports twice.
 */
export const AGENT_HOOK_WRITERS: Readonly<Record<string, () => AgentFirstRunAnswer[]>> = {
    auggie: auggieAnswers,
    kimi: kimiAnswers,
    vibe: vibeAnswers,
    opencode: () => [{ file: w(".opencode/plugins/polaris-activity.ts"), text: opencodeActivityPlugin(OPENCODE_EXPORT) }],
    kilocode: () => [{ file: w(".kilocode/plugins/polaris-activity.ts"), text: opencodeActivityPlugin(OPENCODE_EXPORT) }],
    "mimo-code": () => [
        { file: w(".mimocode/hooks/polaris-activity.ts"), text: opencodeActivityPlugin("export default hooks;") }
    ],
    amp: () => [{ file: w(".amp/plugins/polaris-activity.ts"), text: ampActivityPlugin() }],
    pi: () => [{ file: w(".polaris/hooks/pi-activity.ts"), text: piActivityExtension(false) }],
    omp: () => [{ file: w(".polaris/hooks/omp-activity.ts"), text: piActivityExtension(true) }],
    "prime-agent": () => [{ file: w(".polaris/hooks/prime-agent-activity.ts"), text: piActivityExtension(false) }]
};
