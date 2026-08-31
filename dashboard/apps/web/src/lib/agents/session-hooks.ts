/**
 * How Polaris finds out what a session's agent is doing.
 *
 * The agent is somebody else's program running on a machine. Polaris is not
 * inside it, and reading its terminal tells you almost nothing - a full-screen
 * program repaints, and what it repaints is a picture rather than a transcript.
 *
 * So Polaris registers itself in the agent's own configuration. Every tool that
 * supports lifecycle hooks lets one name a command to run when a turn starts, a
 * tool is about to run, or a turn ends. The command Polaris registers does one
 * thing: it posts what it was handed to this instance. Nothing is parsed on the
 * machine - not the event, not the tool name, nothing - because the machine may
 * not have `jq`, may not have `python`, and is the last place a parsing bug
 * should be discovered. Normalising is done here, where it is a pure function
 * with tests on it.
 *
 * The script itself has to be about as simple as a script gets. It runs on every
 * tool call the agent makes, so it is on the hot path of the agent's own work: a
 * slow one is felt as the agent being slow.
 */

import type { AgentSessionEventKind } from "@polaris/core";

/**
 * The events Polaris asks Claude Code to report.
 *
 * `Notification` earns its place: it is the one that fires when the agent is
 * blocked on a person - waiting for permission to run something, or waiting for
 * an answer - and it is therefore the only source for the state that should
 * actually interrupt somebody. A tool that does not emit it can only ever be
 * shown as working or idle.
 *
 * `PreToolUse` and `PostToolUse` take a matcher because that is the shape their
 * configuration has; `*` is every tool, which is what a live readout needs.
 */
export const CLAUDE_HOOK_EVENTS = [
    { event: "SessionStart", matcher: null },
    { event: "UserPromptSubmit", matcher: null },
    { event: "PreToolUse", matcher: "*" },
    { event: "PostToolUse", matcher: "*" },
    { event: "Notification", matcher: null },
    { event: "Stop", matcher: null },
    { event: "SubagentStop", matcher: null },
    { event: "PreCompact", matcher: null },
    { event: "SessionEnd", matcher: null }
] as const;

/** How long a hook is given before the agent stops waiting for it. Deliberately
 *  short: this is on the agent's own hot path, and a Polaris that is slow to
 *  answer must show up as missing events rather than as a slow agent. */
const HOOK_TIMEOUT_SECONDS = 5;

/**
 * The settings file that registers the hooks, as an object.
 *
 * Written whole rather than merged into whatever was there. A session runs in its
 * own home - a container's, or a directory made for it on a server - so there is
 * nothing of the operator's to preserve, and a merge would be a way to inherit
 * configuration nobody meant to give it.
 */
export function claudeHookSettings(scriptPath: string): Record<string, unknown> {
    const hook = { type: "command", command: scriptPath, timeout: HOOK_TIMEOUT_SECONDS };
    const hooks: Record<string, unknown[]> = {};
    for (const { event, matcher } of CLAUDE_HOOK_EVENTS) {
        hooks[event] = [matcher ? { matcher, hooks: [hook] } : { hooks: [hook] }];
    }
    return { hooks };
}

/**
 * The script every hook runs.
 *
 * Reads the event on standard input, posts it, and gets out of the way. `--max-time`
 * rather than a plain timeout because a hung connection would hold the agent up
 * for as long as the network wanted it to, and the honest failure here is a lost
 * event. It always exits 0: a non-zero exit from a hook is a signal to the agent,
 * and Polaris being unreachable must never be a reason for somebody's agent to
 * change what it was doing.
 */
export function hookScript(ingestUrl: string, token: string): string {
    return [
        "#!/bin/sh",
        "# Written by Polaris. Reports this session's lifecycle events; parses nothing.",
        `curl -sS -m 4 -X POST ${shellQuote(ingestUrl)} \\`,
        `  -H ${shellQuote(`Authorization: Bearer ${token}`)} \\`,
        '  -H "Content-Type: application/json" \\',
        "  --data-binary @- >/dev/null 2>&1",
        "exit 0",
        ""
    ].join("\n");
}

/** Single-quote for a POSIX shell. Everything is safe inside single quotes except
 *  a single quote, which is closed, escaped and reopened. */
export function shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// Reading what arrived
// ---------------------------------------------------------------------------

/** What a vendor's event name means in Polaris's own vocabulary. Anything not
 *  here is dropped rather than guessed at - an event nobody has mapped says
 *  nothing about the state, and inventing one would move the session for reasons
 *  no screen could explain. */
const CLAUDE_EVENT_KINDS: Record<string, AgentSessionEventKind> = {
    SessionStart: "session.start",
    UserPromptSubmit: "prompt",
    PreToolUse: "tool.start",
    PostToolUse: "tool.end",
    // Blocked on a person: a permission prompt, or a question it asked and is
    // waiting on. The one event that should reach somebody.
    Notification: "question",
    Stop: "turn.end",
    SubagentStop: "subagent.end",
    PreCompact: "compact",
    SessionEnd: "session.end"
};

export interface NormalizedHookEvent {
    readonly kind: AgentSessionEventKind;
    readonly detail: string;
    readonly subject: string;
}

/** As much of a value as belongs on a screen. Bounded here rather than at the
 *  database, because what makes it unreadable is length long before it makes the
 *  column complain. */
function clip(value: string, max = 160): string {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

/**
 * One line describing what a tool was asked to do.
 *
 * Per tool rather than generic, because the useful half of the input is a
 * different key in each one and dumping the whole object gives a screen a wall of
 * JSON. Anything unrecognised falls back to the tool's name alone, which is
 * honest and still worth showing.
 */
function toolDetail(tool: string, input: Record<string, unknown>): string {
    const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");
    switch (tool) {
        case "Bash":
            return clip(str("command"));
        case "Read":
        case "Write":
        case "Edit":
        case "NotebookEdit":
            return clip(str("file_path"));
        case "Glob":
        case "Grep":
            return clip(str("pattern"));
        case "WebFetch":
            return clip(str("url"));
        case "Task":
            return clip(str("description"));
        default:
            return "";
    }
}

/**
 * Turn what a machine posted into an event, or null.
 *
 * Null for anything unrecognised, and that is the whole contract: this is fed by
 * a program running against somebody's repository, so the safe reading of an
 * unfamiliar payload is that it says nothing. An event that cannot be placed in
 * the vocabulary must not move the session.
 */
export function normalizeHookEvent(payload: unknown): NormalizedHookEvent | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    const name = typeof record.hook_event_name === "string" ? record.hook_event_name : "";
    const kind = CLAUDE_EVENT_KINDS[name];
    if (!kind) return null;

    const tool = typeof record.tool_name === "string" ? record.tool_name : "";
    const input =
        record.tool_input && typeof record.tool_input === "object"
            ? (record.tool_input as Record<string, unknown>)
            : {};

    if (kind === "tool.start" || kind === "tool.end") {
        const detail = toolDetail(tool, input);
        return { kind, detail: detail ? `${tool}: ${detail}` : tool, subject: tool };
    }
    if (kind === "prompt") {
        return { kind, detail: clip(typeof record.prompt === "string" ? record.prompt : ""), subject: "" };
    }
    if (kind === "question") {
        return { kind, detail: clip(typeof record.message === "string" ? record.message : "Waiting for you"), subject: "" };
    }
    return { kind, detail: "", subject: "" };
}

/**
 * A tool call the agent reported as having failed, told apart from one that
 * worked.
 *
 * Claude reports both through PostToolUse and puts the outcome in the response,
 * so the distinction is made here rather than by registering a second event that
 * not every version emits.
 */
export function hookEventFailed(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const response = (payload as Record<string, unknown>).tool_response;
    if (!response || typeof response !== "object") return false;
    const record = response as Record<string, unknown>;
    return record.success === false || typeof record.error === "string";
}
