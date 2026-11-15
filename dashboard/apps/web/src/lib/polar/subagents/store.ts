/**
 * Subagent runs in the database, always read and written for their owner.
 * A row still marked running that no process holds any more (the dashboard
 * restarted under it) reads as interrupted.
 *
 * Server-only.
 */

import { z } from "zod";
import type { ModelMessage } from "ai";
import { Prisma, prisma } from "@polaris/db";
import { isRunning } from "@/lib/polar/subagents/registry";
import {
    STEPS_LISTED,
    SUMMARY_MAX,
    statusOf,
    stepsOf,
    type SubagentDetail,
    type SubagentLine,
    type SubagentStatus,
    type SubagentStep,
    type SubagentView
} from "@/lib/polar/subagents/shared";

const SELECT = {
    id: true,
    threadId: true,
    toolCallId: true,
    kind: true,
    name: true,
    description: true,
    model: true,
    provider: true,
    background: true,
    status: true,
    failure: true,
    summary: true,
    steps: true,
    inputTokens: true,
    outputTokens: true,
    startedAt: true,
    endedAt: true
} as const;

/** Most runs listed for one chat. */
const LISTED = 100;
/** Biggest stored conversation; past it the oldest tool results are cut. */
const MESSAGES_BYTES_MAX = 512 * 1024;
const uuidSchema = z.string().uuid();

type Row = Prisma.PolarSubagentRunGetPayload<{ select: typeof SELECT }>;

function viewOf(row: Row): SubagentView {
    const stored = statusOf(row.status);
    return {
        ...row,
        status: stored === "running" && !isRunning(row.id) ? "interrupted" : stored,
        steps: stepsOf(row.steps),
        startedAt: row.startedAt.getTime(),
        endedAt: row.endedAt?.getTime() ?? null
    };
}

export interface NewSubagentRun {
    id: string;
    userId: string;
    threadId: string;
    toolCallId: string | null;
    resumedFrom: string | null;
    kind: string;
    agentId: string | null;
    name: string;
    description: string;
    prompt: string;
    provider: string;
    model: string;
    background: boolean;
}

export async function createSubagentRun(input: NewSubagentRun): Promise<void> {
    await prisma.polarSubagentRun.create({ data: input });
}

/** Model messages small enough to keep: a long tool result is cut first. */
export function boundedMessages(messages: readonly ModelMessage[]): ModelMessage[] {
    let kept = [...messages];
    while (kept.length > 1 && JSON.stringify(kept).length > MESSAGES_BYTES_MAX) {
        // The task itself stays; the oldest exchange after it goes.
        kept = [kept[0]!, ...kept.slice(2)];
    }
    return kept;
}

export interface SubagentProgress {
    steps: SubagentStep[];
    messages: readonly ModelMessage[];
    inputTokens: number;
    outputTokens: number;
}

export async function saveSubagentProgress(id: string, progress: SubagentProgress): Promise<void> {
    await prisma.polarSubagentRun.update({
        where: { id },
        data: {
            steps: progress.steps.slice(-STEPS_LISTED) as unknown as Prisma.InputJsonValue,
            messages: boundedMessages(progress.messages) as unknown as Prisma.InputJsonValue,
            inputTokens: progress.inputTokens,
            outputTokens: progress.outputTokens
        }
    });
}

export async function endSubagentRun(
    id: string,
    end: { status: Exclude<SubagentStatus, "running">; summary: string; failure: string | null }
): Promise<void> {
    await prisma.polarSubagentRun.update({
        where: { id },
        data: {
            status: end.status,
            summary: end.summary.slice(0, SUMMARY_MAX),
            failure: end.failure,
            endedAt: new Date()
        }
    });
}

/** A chat's subagents, oldest first; none for a chat that is not the person's. */
export async function listSubagentRuns(userId: string, threadId: string): Promise<SubagentView[]> {
    if (!uuidSchema.safeParse(threadId).success) return [];
    const rows = await prisma.polarSubagentRun.findMany({
        where: { userId, threadId },
        select: SELECT,
        orderBy: { startedAt: "desc" },
        take: LISTED
    });
    return rows.reverse().map(viewOf);
}

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part: { type?: unknown; text?: unknown }) =>
            part?.type === "text" && typeof part.text === "string" ? part.text : ""
        )
        .filter(Boolean)
        .join("\n");
}

/** A stored conversation as transcript lines: the task, steers, words, steps. */
export function linesOf(raw: unknown): SubagentLine[] {
    if (!Array.isArray(raw)) return [];
    const lines: SubagentLine[] = [];
    let asked = false;
    for (const message of raw as { role?: unknown; content?: unknown }[]) {
        if (message?.role === "user") {
            const text = textOf(message.content);
            if (text) lines.push({ role: asked ? "steer" : "task", text });
            asked = true;
        } else if (message?.role === "assistant") {
            const parts = Array.isArray(message.content) ? message.content : [message.content];
            for (const entry of parts as unknown[]) {
                if (typeof entry === "string") {
                    if (entry.trim()) lines.push({ role: "assistant", text: entry });
                    continue;
                }
                const part = entry as { type?: unknown; text?: unknown; toolName?: unknown } | null;
                if (part?.type === "text" && typeof part.text === "string" && part.text.trim())
                    lines.push({ role: "assistant", text: part.text });
                else if (part?.type === "tool-call" && typeof part.toolName === "string")
                    lines.push({ role: "tool", text: "", tool: part.toolName });
            }
        }
    }
    return lines;
}

/** One of the person's subagents with its transcript, or null. */
export async function subagentDetail(userId: string, id: string): Promise<SubagentDetail | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const row = await prisma.polarSubagentRun.findFirst({
        where: { id, userId },
        select: { ...SELECT, prompt: true, messages: true }
    });
    if (!row) return null;
    const { prompt, messages, ...rest } = row;
    return { ...viewOf(rest), prompt, lines: linesOf(messages) };
}

/** What a resume continues from: an ended run of the person's in this chat. */
export async function resumableRun(userId: string, threadId: string, id: string) {
    const row = await prisma.polarSubagentRun.findFirst({
        where: { id, userId, threadId },
        select: { id: true, kind: true, agentId: true, name: true, messages: true, status: true }
    });
    if (!row || isRunning(row.id)) return null;
    return { ...row, messages: Array.isArray(row.messages) ? (row.messages as ModelMessage[]) : [] };
}

/**
 * The background runs that ended since the parent last heard, marked as
 * delivered: their summaries go into its next turn.
 */
export async function takeFinishedBackground(
    userId: string,
    threadId: string
): Promise<{ id: string; name: string; description: string; status: string; summary: string }[]> {
    const rows = await prisma.polarSubagentRun.findMany({
        where: { userId, threadId, background: true, delivered: false, endedAt: { not: null } },
        select: { id: true, name: true, description: true, status: true, summary: true },
        orderBy: { endedAt: "asc" },
        take: 10
    });
    if (rows.length === 0) return [];
    await prisma.polarSubagentRun.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, userId },
        data: { delivered: true }
    });
    return rows;
}

/** Marks rows no process holds as interrupted, so they stop reading as running. */
export async function settleInterrupted(userId: string, threadId: string): Promise<void> {
    const rows = await prisma.polarSubagentRun.findMany({
        where: { userId, threadId, status: "running" },
        select: { id: true },
        take: LISTED
    });
    const gone = rows.filter((row) => !isRunning(row.id)).map((row) => row.id);
    if (gone.length === 0) return;
    await prisma.polarSubagentRun.updateMany({
        where: { id: { in: gone }, userId, status: "running" },
        data: { status: "interrupted", endedAt: new Date() }
    });
}
