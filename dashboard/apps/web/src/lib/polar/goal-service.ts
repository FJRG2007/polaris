/**
 * A chat's `/goal` (`goals.ts`), kept on its thread and judged after each
 * turn of the chat's own answer loop (`api/polar/chat`).
 *
 * The judge is the helper model, as Claude Code's is its small fast model: it
 * reads the condition and what the conversation shows, calls no tools, and
 * answers met, not met or impossible with a short reason. It cannot approve
 * anything and is never asked to.
 *
 * A judgement is saved only over the goal it judged (`goal-store.ts`), so a
 * goal cleared or replaced while its turn ran is never brought back.
 *
 * Server-only.
 */

import { z } from "zod";
import { polarGoal, savePolarGoal } from "@/lib/polar/goal-store";
import { generateText, type UIMessage, type UIMessageChunk } from "ai";
import { classifyProviderFailure, failureLogLine } from "@/lib/polar/provider-failure";
import {
    helperMaySpend,
    helperReasoning,
    recordHelperUsage,
    type PolarHelper
} from "@/lib/polar/helper-model";
import {
    GOAL_PART,
    GOAL_REASON_MAX,
    goalAfterTurn,
    type GoalJudgement,
    type GoalTurnOutcome,
    type PolarGoal
} from "@/lib/polar/goals";

/** How much of the conversation the judge reads, from its end. */
const TRANSCRIPT_MAX = 16_000;
/** How much of one tool's input or output goes into it. */
const TOOL_EXCERPT_MAX = 1_500;
/** Room for the verdict, and a short thought on a reasoning model. */
const OUTPUT_MAX = 512;
const JUDGE_TIMEOUT_MS = 30_000;

function excerpt(value: unknown): string {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    return text.length > TOOL_EXCERPT_MAX ? `${text.slice(0, TOOL_EXCERPT_MAX)}...` : text;
}

type ToolLike = {
    type: string;
    toolName?: string;
    state?: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
};

/** One message as the judge reads it: its words and its tool calls. */
function linesOf(message: UIMessage): string[] {
    const who = message.role === "user" ? "User" : "Assistant";
    return message.parts.flatMap((part): string[] => {
        if (part.type === "text") return part.text.trim() ? [`${who}: ${part.text.trim()}`] : [];
        if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") return [];
        const tool = part as unknown as ToolLike;
        const name = part.type === "dynamic-tool" ? (tool.toolName ?? "tool") : part.type.slice(5);
        const result =
            tool.state === "output-available"
                ? ` -> ${excerpt(tool.output)}`
                : tool.state === "output-error"
                  ? ` -> error: ${excerpt(tool.errorText)}`
                  : tool.state === "output-denied"
                    ? " -> denied by the user"
                    : "";
        return [`Tool ${name}(${excerpt(tool.input)})${result}`];
    });
}

/** The conversation as the judge reads it, the end of it when it is long. */
export function goalTranscript(messages: readonly UIMessage[]): string {
    const text = messages.flatMap(linesOf).join("\n");
    return text.length > TRANSCRIPT_MAX ? text.slice(-TRANSCRIPT_MAX) : text;
}

const SYSTEM = [
    "You judge whether a goal's completion condition holds, from the conversation only.",
    "You cannot run commands or read files: judge only what the assistant has shown.",
    "A claim without evidence in the conversation is not enough.",
    'Reply with only JSON: {"verdict":"met"|"not_met"|"impossible","reason":"..."}.',
    "The reason is one short sentence: what is missing, or what shows it holds.",
    "Use impossible only when the condition can never be satisfied."
].join(" ");

const judgementSchema = z.object({
    verdict: z.enum(["met", "not_met", "impossible"]),
    reason: z.string().trim().min(1)
});

/** The judge's reply as a judgement, or null when it is not one. */
export function parseJudgement(raw: string): GoalJudgement {
    const found = /\{[\s\S]*\}/.exec(raw);
    if (!found) return null;
    let value: unknown;
    try {
        value = JSON.parse(found[0]);
    } catch {
        return null;
    }
    const parsed = judgementSchema.safeParse(value);
    if (!parsed.success) return null;
    const reason = parsed.data.reason.replace(/[\u0000-\u001f\u007f]+/g, " ");
    return { verdict: parsed.data.verdict, reason: reason.slice(0, GOAL_REASON_MAX) };
}

/** Asks the judge; null when it cannot answer (no spend left, a failure). */
export async function judgeGoal(
    userId: string,
    threadId: string,
    condition: string,
    messages: readonly UIMessage[],
    helper: PolarHelper
): Promise<GoalJudgement> {
    if (!(await helperMaySpend(userId, helper))) return null;
    try {
        const { text, totalUsage } = await generateText({
            model: helper.resolved.model,
            system: SYSTEM,
            prompt: `Condition:\n${condition}\n\nConversation:\n${goalTranscript(messages)}`,
            maxOutputTokens: OUTPUT_MAX,
            reasoning: helperReasoning(helper),
            abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS)
        });
        await recordHelperUsage(userId, threadId, helper, totalUsage);
        return parseJudgement(text);
    } catch (error) {
        console.warn(
            failureLogLine(
                "judging a goal",
                helper.resolved.option.providerName,
                classifyProviderFailure(error)
            )
        );
        return null;
    }
}

/** The answer as far as a goal needs it, gathered from its stream. */
interface Gathered {
    text: string;
    tools: Map<string, ToolLike>;
    awaitingApproval: boolean;
    failed: boolean;
}

function gather(into: Gathered, chunk: UIMessageChunk): void {
    if (chunk.type === "text-delta") into.text += chunk.delta;
    else if (chunk.type === "tool-input-available") {
        into.tools.set(chunk.toolCallId, {
            type: `tool-${chunk.toolName}`,
            input: chunk.input,
            state: "input-available"
        });
    } else if (chunk.type === "tool-output-available") {
        const tool = into.tools.get(chunk.toolCallId);
        if (tool) Object.assign(tool, { state: "output-available", output: chunk.output });
    } else if (chunk.type === "tool-output-error") {
        const tool = into.tools.get(chunk.toolCallId);
        if (tool) Object.assign(tool, { state: "output-error", errorText: chunk.errorText });
    } else if (chunk.type === "tool-approval-request") into.awaitingApproval = true;
    else if (chunk.type === "error") into.failed = true;
}

function tokensOf(metadata: unknown): number {
    const usage = (metadata as { usage?: { inputTokens?: unknown; outputTokens?: unknown } })
        ?.usage;
    const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
    return count(usage?.inputTokens) + count(usage?.outputTokens);
}

export interface GoalCheck {
    userId: string;
    threadId: string;
    goal: PolarGoal;
    /** The conversation the turn answered. */
    messages: readonly UIMessage[];
    helper: () => Promise<PolarHelper>;
    now?: () => number;
}

/**
 * Judges the goal when the answer's turn finishes, inside the same stream:
 * the judgement goes into the answer as a part, just before its finish, so
 * the screen knows whether to send the next turn and the stored answer keeps
 * the verdict. A turn waiting on an approval, stopped, or failed is passed
 * through untouched and judged after the turn that finishes it.
 */
export function goalCheckStream(check: GoalCheck): TransformStream<UIMessageChunk, UIMessageChunk> {
    const gathered: Gathered = {
        text: "",
        tools: new Map(),
        awaitingApproval: false,
        failed: false
    };
    return new TransformStream({
        async transform(chunk, controller) {
            gather(gathered, chunk);
            if (chunk.type !== "finish") return controller.enqueue(chunk);
            const outcome: GoalTurnOutcome = {
                awaitingApproval: gathered.awaitingApproval,
                interrupted: gathered.failed,
                usedTools: gathered.tools.size > 0,
                tokens: tokensOf(chunk.messageMetadata)
            };
            const next = await judgedGoal(check, gathered, outcome).catch((error) => {
                console.error("polar: could not judge the goal", error);
                return null;
            });
            if (next) controller.enqueue({ type: GOAL_PART, data: next } as UIMessageChunk);
            controller.enqueue(chunk);
        }
    });
}

async function judgedGoal(
    check: GoalCheck,
    gathered: Gathered,
    outcome: GoalTurnOutcome
): Promise<PolarGoal | null> {
    const now = check.now ?? Date.now;
    // Nothing to judge: settles the counters only to learn that.
    if (!goalAfterTurn(check.goal, outcome, null, now())) return null;
    // Cleared or replaced while the turn ran: nothing continues.
    const current = await polarGoal(check.userId, check.threadId);
    if (current?.id !== check.goal.id || current.status !== "active") return null;
    const answer: UIMessage = {
        id: "answer",
        role: "assistant",
        parts: [
            ...(gathered.text.trim() ? [{ type: "text" as const, text: gathered.text }] : []),
            ...([...gathered.tools.values()] as never[])
        ]
    };
    const judgement = await judgeGoal(
        check.userId,
        check.threadId,
        current.condition,
        [...check.messages, answer],
        await check.helper()
    );
    const next = goalAfterTurn(current, outcome, judgement, now());
    if (!next) return null;
    return (await savePolarGoal(check.userId, check.threadId, next)) ? next : null;
}
