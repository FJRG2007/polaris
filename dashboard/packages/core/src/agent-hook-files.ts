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

/** `hookFileAnswer` as a catalogue entry's `firstRun` list. */
export function hookFileAnswers(cliId: string): AgentFirstRunAnswer[] {
    const answer = hookFileAnswer(cliId);
    return answer ? [answer] : [];
}
