/**
 * Polar subagents, as both sides read them.
 *
 * A subagent is a child run of Polar's own loop, started by the `polar_task`
 * tool: its own context, its own tools (never more than the turn that started
 * it), its own model through the same router, and only its final summary goes
 * back to the parent. It follows Claude Code's Task tool and opencode's
 * `mode: subagent` agents: a type is a description the parent delegates by, a
 * tool list and a model.
 *
 * Client-safe: no server imports.
 */

import { z } from "zod";

/** The tool the parent calls to start (or continue) a subagent. */
export const TASK_TOOL = "polar_task";

/** How many levels below the chat may spawn: 1 means a subagent spawns none. */
export const SUBAGENT_MAX_DEPTH = 1;
/** Most subagents one person may have running at once, across every chat. */
export const SUBAGENTS_MAX = 4;
/** Most subagents one parent turn may start. */
export const SUBAGENTS_PER_TURN = 8;
/** Most tool steps one subagent run may take before it has to answer. */
export const SUBAGENT_STEP_MAX = 16;
/** Most tokens (input and output, every step) one subagent run may spend. */
export const SUBAGENT_TOKEN_MAX = 400_000;
/** Longest one subagent run may work. */
export const SUBAGENT_TIME_MAX_MS = 15 * 60_000;
/** Longest summary handed back to the parent. */
export const SUMMARY_MAX = 12_000;
/** Longest steering message. */
export const STEER_MAX = 4_000;
/** Most steps listed on a card. */
export const STEPS_LISTED = 40;

/** The types that come with Polar, beside the person's own agents. */
export const BUILT_IN_TYPES = ["general", "explore"] as const;
export type BuiltInType = (typeof BUILT_IN_TYPES)[number];

export const SUBAGENT_STATUSES = [
    "running",
    "done",
    "failed",
    "stopped",
    "budget",
    "interrupted"
] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

export function isLiveStatus(status: SubagentStatus): boolean {
    return status === "running";
}

/** What the parent model sends `polar_task`. */
export const taskInputSchema = z.object({
    /** Three to six words the card shows. */
    description: z.string().trim().min(1).max(120),
    /** The whole task: the subagent sees nothing of the chat but this. */
    prompt: z.string().trim().min(1).max(20_000),
    /** "general", "explore", or the name of one of the person's agents. */
    type: z.string().trim().min(1).max(80).default("general"),
    /** Run on while the parent answers; the result reaches its next turn. */
    background: z.boolean().default(false),
    /** A finished subagent's id to continue with its own context kept. */
    resume: z.string().uuid().optional()
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export const subagentStepSchema = z.object({
    tool: z.string().max(200),
    state: z.enum(["running", "done", "failed"]),
    at: z.number()
});
export type SubagentStep = z.infer<typeof subagentStepSchema>;

/** What `polar_task` streams to the screen and stores in the message. */
export const taskOutputSchema = z.object({
    id: z.string().max(64),
    status: z.enum(SUBAGENT_STATUSES),
    name: z.string().max(120),
    model: z.string().max(200).default(""),
    background: z.boolean().default(false),
    summary: z.string().max(SUMMARY_MAX).default(""),
    steps: z.array(subagentStepSchema).max(STEPS_LISTED).default([]),
    startedAt: z.number(),
    endedAt: z.number().nullable().default(null),
    /** Why it could not start or stopped, as a code the screen translates. */
    refusal: z.string().max(40).nullable().default(null)
});
export type TaskOutput = z.infer<typeof taskOutputSchema>;

/** A stored task output, or null when it does not read. */
export function readTaskOutput(raw: unknown): TaskOutput | null {
    const parsed = taskOutputSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** One line of a subagent's transcript, as the screen shows it. */
export interface SubagentLine {
    role: "task" | "assistant" | "tool" | "steer";
    text: string;
    tool?: string;
}

/** A subagent as the panel and its transcript read it. */
export interface SubagentView {
    id: string;
    threadId: string;
    toolCallId: string | null;
    kind: string;
    name: string;
    description: string;
    model: string;
    provider: string;
    background: boolean;
    status: SubagentStatus;
    failure: string | null;
    summary: string;
    steps: SubagentStep[];
    inputTokens: number;
    outputTokens: number;
    startedAt: number;
    endedAt: number | null;
}

export interface SubagentDetail extends SubagentView {
    prompt: string;
    lines: SubagentLine[];
}

/** What the screen posts to a subagent. */
export const subagentActionSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("stop") }),
    z.object({ action: z.literal("steer"), text: z.string().trim().min(1).max(STEER_MAX) })
]);
export type SubagentAction = z.infer<typeof subagentActionSchema>;

/** A steps list, read whole: an entry that no longer reads is left out. */
export function stepsOf(raw: unknown): SubagentStep[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        const parsed = subagentStepSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

/** A status read from storage, unknown ones as interrupted. */
export function statusOf(raw: unknown): SubagentStatus {
    return SUBAGENT_STATUSES.includes(raw as SubagentStatus)
        ? (raw as SubagentStatus)
        : "interrupted";
}

/** A task call the screen saw fail before it reported anything. */
export function erroredTask(): TaskOutput {
    return {
        id: "",
        status: "failed",
        name: "",
        model: "",
        background: false,
        summary: "",
        steps: [],
        startedAt: 0,
        endedAt: 0,
        refusal: "invalid"
    };
}
