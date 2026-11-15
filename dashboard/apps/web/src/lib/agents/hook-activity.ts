// Ported from backend/internal/adapters/agent/activitystate/activitystate.go,
// backend/internal/adapters/agent/activitydispatch/dispatch.go and the
// DeriveActivityState of each agent in backend/internal/adapters/agent/<name>/
// in Agent Orchestrator (Apache-2.0, github.com/OrchestratorInc/agent-orchestrator,
// commit e4ded08c6f15).

import { hookSignalOf, type HookSignal } from "@polaris/core";

/**
 * What a session's agent is doing, as its last hook says.
 *
 * - `active`: working - a prompt came in, a tool ran.
 * - `idle`: its turn is over and it waits for the next prompt.
 * - `waiting_input`: paused on the person, but anything they send is welcome.
 * - `blocked`: stopped on a permission prompt that has to be answered first.
 * - `exited`: the agent's process is gone.
 */
export const HOOK_ACTIVITIES = ["active", "idle", "waiting_input", "blocked", "exited"] as const;
export type HookActivity = (typeof HOOK_ACTIVITIES)[number];

type Payload = Record<string, unknown>;
type Derive = (signal: HookSignal, payload: Payload) => HookActivity | null;

const text = (payload: Payload, key: string): string =>
    typeof payload[key] === "string" ? (payload[key] as string) : "";

const TOOL_TRAFFIC: ReadonlySet<HookSignal> = new Set([
    "pre-tool-use",
    "post-tool-use",
    "post-tool-use-failure"
]);

/**
 * The name-only mapping most tools share. Tool traffic is work, a turn's end is
 * idle, and a permission request is `waiting_input` rather than `blocked`:
 * these tools report no event that would clear a block before the turn ends.
 */
const standard: Derive = (signal) => {
    if (signal === "session-start" || signal === "user-prompt-submit" || TOOL_TRAFFIC.has(signal))
        return "active";
    if (signal === "stop") return "idle";
    if (signal === "permission-request") return "waiting_input";
    return null;
};

/** Claude Code's notification types, split by what unblocks them. */
function notificationActivity(payload: Payload): HookActivity | null {
    switch (text(payload, "notification_type")) {
        case "idle_prompt":
        case "agent_completed":
            return "idle";
        case "agent_needs_input":
            return "waiting_input";
        case "permission_prompt":
            return "blocked";
        default:
            return null;
    }
}

/**
 * The session-end reasons that only swap the conversation while the agent
 * keeps running, for the tools whose end event says why it fired.
 */
const SWAP_REASONS: Readonly<Record<string, readonly string[]>> = {
    claude: ["clear", "resume"],
    droid: ["clear"],
    kimchi: ["reload", "new", "resume", "fork"]
};

function endActivity(cliId: string, payload: Payload): HookActivity | null {
    return sessionEndIsSwap(cliId, payload) ? null : "exited";
}

/**
 * Whether a session-end hook only replaced the conversation (a `/clear`, a
 * reload, a fork) rather than ending the agent. False for a tool whose end
 * event carries no reason.
 */
export function sessionEndIsSwap(cliId: string, payload: unknown): boolean {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    return (SWAP_REASONS[cliId] ?? []).includes(text(payload as Payload, "reason"));
}

const claude: Derive = (signal, payload) => {
    if (signal === "user-prompt-submit" || TOOL_TRAFFIC.has(signal)) return "active";
    if (signal === "permission-request") return "blocked";
    if (signal === "stop" || signal === "stop-failure") return "idle";
    if (signal === "notification") return notificationActivity(payload);
    if (signal === "session-end") return endActivity("claude", payload);
    return null;
};

const DERIVERS: Readonly<Record<string, Derive>> = {
    claude,
    codex: (signal) =>
        signal === "user-prompt-submit"
            ? "active"
            : signal === "permission-request"
              ? "waiting_input"
              : signal === "stop"
                ? "idle"
                : null,
    gemini: (signal, payload) => {
        if (signal === "session-start" || signal === "user-prompt-submit" || signal === "post-tool-use")
            return "active";
        if (signal === "stop") return "idle";
        if (signal === "notification" && text(payload, "notification_type") === "ToolPermission")
            return "waiting_input";
        return null;
    },
    droid: (signal, payload) => {
        if (signal === "user-prompt-submit") return "active";
        if (signal === "stop") return "idle";
        if (signal === "notification") return "waiting_input";
        if (signal === "session-end") return endActivity("droid", payload);
        return null;
    },
    kimchi: (signal, payload) => {
        if (signal === "user-prompt-submit" || TOOL_TRAFFIC.has(signal)) return "active";
        if (signal === "stop") return "idle";
        if (signal === "notification") return notificationActivity(payload);
        if (signal === "session-end") return endActivity("kimchi", payload);
        return null;
    },
    agy: (signal) =>
        signal === "pre-invocation" || signal === "post-tool-use" ? "active" : signal === "stop" ? "idle" : null,
    "command-code": (signal) =>
        signal === "pre-tool-use" || signal === "post-tool-use" ? "active" : signal === "stop" ? "idle" : null,
    // Cursor's `before*` events are permission gates Polaris does not register,
    // so every tool event it does send is one that already ran.
    cursor: (signal) =>
        signal === "session-start" || signal === "user-prompt-submit" || TOOL_TRAFFIC.has(signal)
            ? "active"
            : signal === "stop"
              ? "idle"
              : null,
    copilot: standard,
    qwen: standard,
    goose: standard,
    openhands: standard,
    devin: standard,
    autohand: standard
};

/**
 * Native event names for the tools whose hooks report in their own words
 * rather than through `POLARIS_HOOK_EVENT` (see `HOOK_SIGNAL_EVENTS`).
 */
const NATIVE_SIGNALS: Readonly<Record<string, Readonly<Record<string, HookSignal>>>> = {
    gemini: {
        SessionStart: "session-start",
        BeforeAgent: "user-prompt-submit",
        AfterTool: "post-tool-use",
        AfterAgent: "stop",
        Notification: "notification"
    },
    copilot: {
        sessionStart: "session-start",
        userPromptSubmitted: "user-prompt-submit",
        preToolUse: "pre-tool-use",
        postToolUse: "post-tool-use",
        permissionRequest: "permission-request",
        notification: "notification",
        agentStop: "stop",
        sessionEnd: "session-end"
    }
};

/** Whether Polaris can tell this tool's activity from its hooks at all. */
export function hasHookActivity(cliId: string): boolean {
    return cliId in DERIVERS;
}

/**
 * The activity one hook payload reports for a tool, or null where the event
 * says nothing about it (a compaction, a subagent, a tool Polaris does not
 * read hooks from).
 */
export function hookActivity(cliId: string, payload: unknown): HookActivity | null {
    const derive = DERIVERS[cliId];
    if (!derive || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const record = payload as Payload;
    const event = text(record, "hook_event_name");
    const signal = NATIVE_SIGNALS[cliId]?.[event] ?? hookSignalOf(event);
    return signal ? derive(signal, record) : null;
}
