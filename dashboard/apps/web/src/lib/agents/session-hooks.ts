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

import { isTranscriptPath, isVendorSessionId, type AgentSessionEventKind } from "@polaris/core";

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
    // The permission prompt itself, with the tool and what it would do. The
    // reliable source for "Needs you"; Notification is the fallback for a
    // question the agent asked.
    { event: "PermissionRequest", matcher: "*" },
    { event: "Notification", matcher: null },
    { event: "Stop", matcher: null },
    // A turn that ended on an API error or a usage limit. Without it such a
    // session stayed on "Working" with nothing left running.
    { event: "StopFailure", matcher: null },
    { event: "SubagentStop", matcher: null },
    // After, not before: a manual /compact never sends Stop, so the end of the
    // compaction is the only thing that says the agent is back at its prompt.
    { event: "PostCompact", matcher: null },
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
 * The MCP registration a session is given.
 *
 * This is what stops "connect your agent to Polaris" being a setup step. An agent
 * in a session can read the task it was given, move it on and comment on it from
 * its first turn, because the server was already in its project configuration
 * when it started.
 *
 * The credential is the session's own reporting token rather than an API key.
 * Nobody has to mint one, it dies with the session, and it carries less than a
 * key would: enough to work the board it was pointed at, and not enough to start
 * more sessions.
 */
export function mcpConfig(url: string, token: string): Record<string, unknown> {
    return {
        mcpServers: {
            polaris: {
                type: "http",
                url,
                headers: { Authorization: `Bearer ${token}` }
            }
        }
    };
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
        "# Written by Polaris. Reports this session's lifecycle events.",
        // When the hook ran, taken here: posts can overtake each other on the
        // way, and this is what puts them back in order. See applySessionEvents.
        "seq=$(date +%s%N 2>/dev/null || true)",
        'payload="$(cat)"',
        // Copilot CLI does not name the event in its payload, so its hook
        // configuration names it in the environment and it is added here.
        'event="${POLARIS_HOOK_EVENT:-}"',
        'case "$event" in *[!A-Za-z]*) event="" ;; esac',
        'if [ -n "$event" ]; then',
        "  inner=\"${payload#\\{}\"",
        "  case \"$inner\" in",
        "    *[!}[:space:]]*) payload=\"{\\\"hook_event_name\\\":\\\"$event\\\",$inner\" ;;",
        "    *) payload=\"{\\\"hook_event_name\\\":\\\"$event\\\"}\" ;;",
        "  esac",
        "fi",
        // The agent's own id for the conversation, kept beside this script, so a
        // machine that restarts under the session reopens that conversation
        // rather than a blank one (see LAUNCH_SCRIPT). The first match is the
        // payload's own: every hook puts it before anything the agent said.
        // Only a hint for the reboot - Polaris stores what it parses itself.
        `id="$(printf %s "$payload" | grep -o '"session_\\{0,1\\}[iI]d" *: *"[A-Za-z0-9_-]*"' | head -n 1 | cut -d '"' -f 4)"`,
        'if [ -n "$id" ]; then printf %s "$id" > "$(dirname "$0")/agent-session-id" 2>/dev/null || true; fi',
        `printf %s "$payload" | curl -sS -m 4 -X POST ${shellQuote(ingestUrl)} \\`,
        '  -H "X-Polaris-Seq: $seq" \\',
        `  -H ${shellQuote(`Authorization: Bearer ${token}`)} \\`,
        '  -H "Content-Type: application/json" \\',
        "  --data-binary @- >/dev/null 2>&1",
        // Codex and Gemini CLI read a hook's output as JSON; this one decides
        // nothing, so it says so.
        'printf "{}"',
        "exit 0",
        ""
    ].join("\n");
}

/**
 * The git credential helper a session's checkout is given.
 *
 * The agent never holds a GitHub token of its own. When its git needs one - a
 * fetch, a push of its branch - git runs this, and this asks Polaris for a fresh
 * token with the session's own reporting token. Polaris mints it for the one
 * repository the session works in, with permission to read and write its
 * contents and nothing else, so a token an agent is talked into printing is
 * worth an hour on one repository rather than every repository of the
 * installation. Only `get` is answered: git's `store` and `erase` have nothing
 * to keep here. And only for https://github.com: a remote or submodule pointed
 * anywhere else is handed nothing.
 */
export function gitCredentialScript(url: string, token: string): string {
    return [
        "#!/bin/sh",
        "# Written by Polaris. Hands git a short-lived token for this session's repository.",
        '[ "$1" = "get" ] || exit 0',
        'protocol=""',
        'host=""',
        'while IFS= read -r line && [ -n "$line" ]; do',
        '    case "$line" in',
        '        protocol=*) protocol="${line#protocol=}" ;;',
        '        host=*) host="${line#host=}" ;;',
        "    esac",
        "done",
        '[ "$protocol" = "https" ] && [ "$host" = "github.com" ] || exit 0',
        `curl -sS -f -m 15 -X POST ${shellQuote(url)} \\`,
        `  -H ${shellQuote(`Authorization: Bearer ${token}`)} 2>/dev/null`,
        "exit 0",
        ""
    ].join("\n");
}

/** Single-quote for a POSIX shell. Everything is safe inside single quotes except
 *  a single quote, which is closed, escaped and reopened. */
export function shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * A directory as the shell should see it.
 *
 * A container checkout is an absolute path, but a server's is stored as
 * `$HOME/.polaris/...` - the one place a session's directory is relative to
 * whoever it runs as - and quoting the whole of that would hand `cd` a directory
 * literally named `$HOME`.
 */
export function shellPath(path: string): string {
    if (path === "$HOME") return '"$HOME"';
    if (path.startsWith("$HOME/")) return `"$HOME"/${shellQuote(path.slice("$HOME/".length))}`;
    return shellQuote(path);
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
    PermissionRequest: "permission",
    Stop: "turn.end",
    StopFailure: "turn.failed",
    SubagentStop: "subagent.end",
    PostCompact: "compact",
    SessionEnd: "session.end",
    // Codex uses Claude Code's names; these are the ones it adds.
    Interrupt: "turn.end",
    // Gemini CLI.
    BeforeAgent: "prompt",
    BeforeTool: "tool.start",
    AfterTool: "tool.end",
    AfterAgent: "turn.end",
    PreCompress: "compact",
    // Copilot CLI, camelCase.
    sessionStart: "session.start",
    userPromptSubmitted: "prompt",
    preToolUse: "tool.start",
    postToolUse: "tool.end",
    permissionRequest: "permission",
    notification: "question",
    agentStop: "turn.end",
    errorOccurred: "turn.failed",
    sessionEnd: "session.end"
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
    const str = (key: string): string =>
        typeof input[key] === "string" ? (input[key] as string) : "";
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
/** A tool call's arguments, as an object or as the JSON string Copilot CLI sends. */
function toolInput(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            return {};
        }
    }
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/** An error as text, whether it came as a string or as `{ message }`. */
function errorText(value: unknown): unknown {
    if (value && typeof value === "object" && "message" in value)
        return (value as { message: unknown }).message;
    return value;
}

export function normalizeHookEvent(payload: unknown): NormalizedHookEvent | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    const name = typeof record.hook_event_name === "string" ? record.hook_event_name : "";
    const kind = CLAUDE_EVENT_KINDS[name];
    if (!kind) return null;

    const tool =
        typeof record.tool_name === "string"
            ? record.tool_name
            : typeof record.toolName === "string"
              ? record.toolName
              : "";
    const input = toolInput(record.tool_input ?? record.toolArgs);

    // Gemini CLI tells an approval prompt apart from any other notice only by
    // its type.
    if (name === "Notification" && record.notification_type === "ToolPermission")
        return {
            kind: "permission",
            detail: clip(typeof record.message === "string" ? record.message : tool),
            subject: tool
        };

    // The 60-second "still waiting for your input" nudge fires after a turn
    // has already ended. It says nothing Stop did not, and reading it as a
    // permission prompt would interrupt somebody about a finished turn.
    if (kind === "question" && record.notification_type === "idle_prompt") return null;
    // An automatic compaction happens mid-turn and the turn carries on.
    if (kind === "compact" && record.trigger === "auto") return null;
    // Clearing or swapping the conversation is the tool starting over, not
    // ending: the agent is still running in the same terminal.
    if (kind === "session.end" && (record.reason === "clear" || record.reason === "resume"))
        return { kind: "session.clear", detail: "", subject: "" };
    if (kind === "turn.failed") {
        const said = [errorText(record.error), record.error_details]
            .filter((part): part is string => typeof part === "string" && part.trim() !== "")
            .join(": ");
        return { kind, detail: clip(said || "The turn stopped on an error"), subject: "" };
    }

    if (kind === "tool.start" || kind === "tool.end" || kind === "permission") {
        const detail = toolDetail(tool, input);
        return { kind, detail: detail ? `${tool}: ${detail}` : tool, subject: tool };
    }
    if (kind === "prompt") {
        return {
            kind,
            detail: clip(typeof record.prompt === "string" ? record.prompt : ""),
            subject: ""
        };
    }
    if (kind === "question") {
        return {
            kind,
            detail: clip(typeof record.message === "string" ? record.message : "Waiting for you"),
            subject: ""
        };
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

/** What a hook said about the conversation itself, rather than about a turn. */
export interface HookConversation {
    readonly vendorSessionId: string | null;
    readonly transcriptPath: string | null;
}

/**
 * The agent's own id for its conversation and where it keeps the transcript.
 *
 * Every Claude hook carries both, whatever the event. Each is kept only if it
 * passes its check - the id ends up typed into a shell by the Resume button - and
 * one that does not is read as absent rather than as a reason to drop the event.
 */
export function hookConversation(payload: unknown): HookConversation {
    if (!payload || typeof payload !== "object")
        return { vendorSessionId: null, transcriptPath: null };
    const record = payload as Record<string, unknown>;
    return {
        vendorSessionId: isVendorSessionId(record.session_id)
            ? record.session_id
            : isVendorSessionId(record.sessionId)
              ? record.sessionId
              : null,
        transcriptPath: isTranscriptPath(record.transcript_path) ? record.transcript_path : null
    };
}
