/**
 * The subagents a Code session's CLI ran, as a tree, read from its hook
 * payloads in the order they arrived.
 *
 * Claude Code starts one through its `Agent` tool (`Task` before 2.1): the
 * PreToolUse of that call carries the description and the subagent type, then
 * SubagentStart names the new agent (`agent_id`, `agent_type`), every tool
 * event fired inside it carries the same `agent_id`, and SubagentStop closes
 * it with the transcript path. A start is paired with the oldest call of its
 * type that has none yet, which is the order the CLI launches them in.
 *
 * Pure and total: a payload it does not recognise is skipped, never a reason
 * to drop the tree.
 */

import { z } from "zod";

export type SubagentStatus = "running" | "done" | "failed" | "stopped";

export interface SubagentStep {
    readonly tool: string;
    /** The tool call's id, when the CLI gave one. */
    readonly id: string | null;
    readonly status: "running" | "done" | "failed";
    readonly startedAt: number | null;
    readonly endedAt: number | null;
}

export interface SubagentNode {
    /** The CLI's agent id, or the launching call's id until it started. */
    readonly id: string;
    readonly agentId: string | null;
    readonly toolUseId: string | null;
    readonly type: string;
    readonly description: string;
    readonly status: SubagentStatus;
    readonly startedAt: number | null;
    readonly endedAt: number | null;
    readonly transcriptPath: string | null;
    readonly steps: readonly SubagentStep[];
}

/** One hook payload as it arrived, with when it arrived. */
export interface TimedHookPayload {
    readonly payload: unknown;
    readonly at: number | null;
}

/** The tool that launches a subagent, by its current and its earlier name. */
export const SUBAGENT_LAUNCHERS = ["Agent", "Task"] as const;
const LAUNCHERS = new Set<string>(SUBAGENT_LAUNCHERS);
const STEPS_MOST = 500;
const SUBAGENTS_MOST = 100;
const TEXT_MAX = 200;
/** An absolute or home-relative path ending in `.jsonl`, with nothing a shell
 *  or a URL would read. The hooks reference shows `~/.claude/projects/...`. */
const TRANSCRIPT = /^~?\/[A-Za-z0-9._\/-]{1,1024}\.jsonl$/;
/** The CLI's agent ids (`agent-abc123`, `def456`) and tool call ids (`toolu_...`). */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TYPE_MAX = 80;

const text = z.string().max(4096);
const payloadSchema = z.object({
    hook_event_name: text,
    agent_id: text.optional(),
    agent_type: text.optional(),
    agent_transcript_path: text.optional(),
    tool_name: text.optional(),
    tool_use_id: text.optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    tool_response: z.unknown().optional()
});

function clip(value: unknown): string {
    if (typeof value !== "string") return "";
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}...` : flat;
}

function failedResponse(response: unknown): boolean {
    if (!response || typeof response !== "object") return false;
    const record = response as Record<string, unknown>;
    return record.success === false || typeof record.error === "string" || record.is_error === true;
}

interface Building {
    id: string;
    agentId: string | null;
    toolUseId: string | null;
    type: string;
    description: string;
    status: SubagentStatus;
    startedAt: number | null;
    endedAt: number | null;
    transcriptPath: string | null;
    steps: SubagentStep[];
}

/** The subagents in a session's hook payloads, in the order they were launched. */
export function decodeSubagentTree(events: readonly TimedHookPayload[]): SubagentNode[] {
    const nodes: Building[] = [];
    const byAgent = new Map<string, Building>();
    const byCall = new Map<string, Building>();
    const closeRunning = (at: number | null) => {
        for (const node of nodes) {
            if (node.status !== "running") continue;
            node.status = "stopped";
            node.endedAt = at;
            node.steps = node.steps.map((step) =>
                step.status === "running" ? { ...step, status: "failed", endedAt: at } : step
            );
        }
    };

    for (const { payload, at } of events) {
        const parsed = payloadSchema.safeParse(payload);
        if (!parsed.success) continue;
        const event = parsed.data;
        const name = event.hook_event_name;
        const tool = event.tool_name ?? "";

        // A tool fired inside a subagent: one of its steps.
        if ((name === "PreToolUse" || name === "PostToolUse") && event.agent_id) {
            const node = byAgent.get(event.agent_id);
            if (!node) continue;
            if (name === "PreToolUse") {
                if (node.steps.length < STEPS_MOST)
                    node.steps.push({
                        tool: clip(tool),
                        id: event.tool_use_id ?? null,
                        status: "running",
                        startedAt: at,
                        endedAt: null
                    });
                continue;
            }
            const index = node.steps.findIndex(
                (step) =>
                    step.status === "running" &&
                    (event.tool_use_id ? step.id === event.tool_use_id : step.tool === tool)
            );
            if (index < 0) continue;
            node.steps[index] = {
                ...node.steps[index]!,
                status: failedResponse(event.tool_response) ? "failed" : "done",
                endedAt: at
            };
            continue;
        }

        // The main agent launching one.
        if (name === "PreToolUse" && LAUNCHERS.has(tool)) {
            if (nodes.length >= SUBAGENTS_MOST) continue;
            const input = event.tool_input ?? {};
            const node: Building = {
                id: event.tool_use_id ?? `call-${nodes.length}`,
                agentId: null,
                toolUseId: event.tool_use_id ?? null,
                type: clip(input.subagent_type) || "general-purpose",
                description: clip(input.description),
                status: "running",
                startedAt: at,
                endedAt: null,
                transcriptPath: null,
                steps: []
            };
            nodes.push(node);
            if (node.toolUseId) byCall.set(node.toolUseId, node);
            continue;
        }
        if (name === "PostToolUse" && LAUNCHERS.has(tool)) {
            const node = event.tool_use_id ? byCall.get(event.tool_use_id) : undefined;
            if (!node || node.status !== "running") continue;
            node.status = failedResponse(event.tool_response) ? "failed" : "done";
            node.endedAt = at;
            continue;
        }

        if (name === "SubagentStart" && event.agent_id) {
            if (byAgent.has(event.agent_id)) continue;
            const type = clip(event.agent_type);
            let node = nodes.find((entry) => entry.agentId === null && entry.status === "running" && entry.type === type);
            // Started without a launch seen (the hook was installed mid-turn).
            if (!node) {
                if (nodes.length >= SUBAGENTS_MOST) continue;
                node = {
                    id: event.agent_id,
                    agentId: null,
                    toolUseId: null,
                    type: type || "general-purpose",
                    description: "",
                    status: "running",
                    startedAt: at,
                    endedAt: null,
                    transcriptPath: null,
                    steps: []
                };
                nodes.push(node);
            }
            node.agentId = event.agent_id;
            node.id = event.agent_id;
            byAgent.set(event.agent_id, node);
            continue;
        }

        if (name === "SubagentStop" && event.agent_id) {
            const node = byAgent.get(event.agent_id);
            if (!node) continue;
            const path = event.agent_transcript_path;
            if (path && isSubagentTranscript(path)) node.transcriptPath = path;
            // Stopped too: a background subagent outlives the turn that
            // launched it, and its own end is the better word.
            if (node.status === "running" || node.status === "stopped") {
                node.status = "done";
                node.endedAt = at;
            }
            continue;
        }

        // The turn ended: whatever still runs was stopped with it.
        if (name === "Stop" || name === "StopFailure" || name === "SessionEnd") closeRunning(at);
    }
    return nodes.map((node) => ({ ...node, steps: [...node.steps] }));
}

/** How long a subagent ran, in milliseconds, or null while it is unknown. */
export function subagentDuration(node: SubagentNode, now: number): number | null {
    if (node.startedAt === null) return null;
    return Math.max(0, (node.endedAt ?? (node.status === "running" ? now : node.startedAt)) - node.startedAt);
}

function isSubagentTranscript(path: string): boolean {
    return TRANSCRIPT.test(path) && !path.split("/").includes("..");
}

/** What one stored event keeps of its hook payload, for the tree to be read
 *  again later. Every field null when the payload does not carry it. */
export interface SubagentRef {
    readonly agentId: string | null;
    readonly agentType: string | null;
    /** The tool call's id, or a finished subagent's transcript path. */
    readonly ref: string | null;
}

const refSchema = z.object({
    hook_event_name: text,
    agent_id: text.optional(),
    agent_type: text.optional(),
    agent_transcript_path: text.optional(),
    tool_name: text.optional(),
    tool_use_id: text.optional(),
    tool_input: z.object({ subagent_type: z.unknown().optional() }).passthrough().optional()
});

/** The subagent fields of a hook payload, checked; nothing for a payload that
 *  has none or carries them in a shape this does not trust. */
export function hookSubagentRef(payload: unknown): SubagentRef {
    const none: SubagentRef = { agentId: null, agentType: null, ref: null };
    const parsed = refSchema.safeParse(payload);
    if (!parsed.success) return none;
    const event = parsed.data;
    const agentId = event.agent_id && AGENT_ID.test(event.agent_id) ? event.agent_id : null;
    const launcher = !agentId && LAUNCHERS.has(event.tool_name ?? "");
    const type = clip(launcher ? event.tool_input?.subagent_type : event.agent_type).slice(0, TYPE_MAX);
    const path = event.agent_transcript_path;
    const ref =
        event.hook_event_name === "SubagentStop"
            ? path && isSubagentTranscript(path)
                ? path
                : null
            : event.tool_use_id && CALL_ID.test(event.tool_use_id)
              ? event.tool_use_id
              : null;
    return { agentId, agentType: (agentId || launcher) && type ? type : null, ref };
}

/** One stored session event, as the thread reads it back. */
export interface StoredSubagentEvent extends SubagentRef {
    readonly kind: string;
    readonly detail: string;
    readonly subject: string;
    readonly at: number;
}

/** The hook payload a stored event came from, as far as the tree needs it. */
function payloadOf(row: StoredSubagentEvent): Record<string, unknown> | null {
    const ids = {
        ...(row.agentId ? { agent_id: row.agentId } : {}),
        ...(row.agentType ? { agent_type: row.agentType } : {})
    };
    switch (row.kind) {
        case "tool.start": {
            const launcher = !row.agentId && LAUNCHERS.has(row.subject);
            const prefix = `${row.subject}: `;
            const description = row.detail.startsWith(prefix) ? row.detail.slice(prefix.length) : "";
            return {
                hook_event_name: "PreToolUse",
                tool_name: row.subject,
                ...(row.ref ? { tool_use_id: row.ref } : {}),
                ...(launcher
                    ? { tool_input: { description, ...(row.agentType ? { subagent_type: row.agentType } : {}) } }
                    : ids)
            };
        }
        case "tool.end":
        case "tool.failed":
            return {
                hook_event_name: "PostToolUse",
                tool_name: row.subject,
                ...(row.ref ? { tool_use_id: row.ref } : {}),
                ...(row.kind === "tool.failed" ? { tool_response: { success: false } } : {}),
                ...ids
            };
        case "subagent.start":
            return { hook_event_name: "SubagentStart", ...ids };
        case "subagent.end":
            return {
                hook_event_name: "SubagentStop",
                ...ids,
                ...(row.ref ? { agent_transcript_path: row.ref } : {})
            };
        case "turn.end":
            return { hook_event_name: "Stop" };
        case "turn.failed":
            return { hook_event_name: "StopFailure" };
        case "session.end":
        case "session.clear":
            return { hook_event_name: "SessionEnd" };
        default:
            return null;
    }
}

/** The tree from a session's stored events, oldest first. */
export function subagentTreeFromEvents(rows: readonly StoredSubagentEvent[]): SubagentNode[] {
    const events: TimedHookPayload[] = [];
    for (const row of rows) {
        const payload = payloadOf(row);
        if (payload) events.push({ payload, at: row.at });
    }
    return decodeSubagentTree(events);
}

/** The stored tool events: a launch and its end (subject one of
 *  `SUBAGENT_LAUNCHERS`), or a step inside a subagent (an `agentId`). */
export const SUBAGENT_TOOL_KINDS = ["tool.start", "tool.end", "tool.failed"] as const;
/** The other stored events the tree reads: the subagents' own, and the
 *  turn's end that stops whatever still runs. */
export const SUBAGENT_MARKER_KINDS = [
    "subagent.start",
    "subagent.end",
    "turn.end",
    "turn.failed",
    "session.end",
    "session.clear"
] as const;
