/**
 * One subagent run: a child of Polar's loop with its own context (only the
 * task it was handed), its own tools (a subset of its parent's, `tools.ts`)
 * and its own model, bounded by steps, tokens and time. Its steps reach the
 * card as they happen; only its final words go back to the parent.
 *
 * Server-only.
 */

import {
    generateText,
    isStepCount,
    type LanguageModelUsage,
    type ModelMessage,
    type StopCondition,
    type ToolSet
} from "ai";
import { polarOutputTokens } from "@/lib/polar/credit";
import type { ResolvedModel } from "@/lib/polar/models";
import { agentPrompt } from "@/lib/polar/agents/shared";
import { foundInSteps } from "@/lib/polar/tool-relevance";
import { classifyProviderFailure, failureLogLine } from "@/lib/polar/provider-failure";
import { admitSubagent, releaseSubagent, takeSteers } from "@/lib/polar/subagents/registry";
import {
    createSubagentRun,
    endSubagentRun,
    resumableRun,
    saveSubagentProgress
} from "@/lib/polar/subagents/store";
import { findSubagentType, type SubagentType } from "@/lib/polar/subagents/types";
import { scopedTools, scopedToolNames, type ApprovalRule } from "@/lib/polar/subagents/tools";
import * as shared from "@/lib/polar/subagents/shared";

/** What the turn that starts subagents lends them. */
export interface SubagentHost {
    userId: string;
    threadId: string;
    /** The tools the parent turn is offered, already narrowed to the person. */
    tools: ToolSet;
    approval: Readonly<Record<string, ApprovalRule>>;
    /** The tools under the web switch, left out for an agent with the web off. */
    webNames: ReadonlySet<string>;
    /** The names sent at the start of a step, given the ones `find_tools` found. */
    active: (found: ReadonlySet<string>) => string[];
    /** The model a type runs on; null when none of its models can be used. */
    resolve: (type: SubagentType) => Promise<ResolvedModel | null>;
    /** The parent turn's stop switch: it stops every subagent it waits on. */
    signal: AbortSignal;
    /** How deep the parent is: 0 for the chat itself. */
    depth: number;
    types: readonly SubagentType[];
    /** Records what a run spent. */
    spent: (resolved: ResolvedModel, usage: LanguageModelUsage) => Promise<void>;
    /** How many subagents this turn started, shared by its calls. */
    started: { count: number };
}

export type SubagentRefusal = "unknown_type" | "too_many" | "no_model" | "not_resumable";

const BASE_PROMPT = [
    "You are a subagent: another assistant handed you one task and sees nothing of your work but your final message.",
    "You see nothing of its conversation either - only the task below. Work it through with your tools, step by step.",
    "When you are done, end with a final message that reports what you found or did, concretely and completely (names, numbers, links), in a few short paragraphs or a list. Do not ask questions back; if something is missing, say what and stop."
].join("\n");

function systemFor(type: SubagentType): string {
    return [
        BASE_PROMPT,
        type.agent ? agentPrompt(type.agent) : type.instructions,
        `Today is ${new Date().toISOString().slice(0, 10)}.`
    ]
        .filter(Boolean)
        .join("\n\n");
}

function tokensOf(usage: Partial<LanguageModelUsage> | undefined): number {
    return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

/** Stops the loop once the run has spent its token allowance. */
export function tokenBudget(max: number): StopCondition<ToolSet> {
    return ({ steps }) => steps.reduce((sum, step) => sum + tokensOf(step.usage), 0) >= max;
}

export interface SubagentStart {
    input: shared.TaskInput;
    toolCallId: string | null;
    /** Called with every change, for the card. */
    onProgress?: (output: shared.TaskOutput) => void;
}

/**
 * Starts a subagent and resolves with its end, or with why it could not start.
 * A background run is not tied to the parent's stop switch; one the parent
 * waits on is.
 */
export async function runSubagent(
    host: SubagentHost,
    start: SubagentStart
): Promise<shared.TaskOutput | SubagentRefusal> {
    const { input } = start;
    const resumed = input.resume
        ? await resumableRun(host.userId, host.threadId, input.resume)
        : null;
    if (input.resume && !resumed) return "not_resumable";
    const type = findSubagentType(host.types, resumed?.name ?? input.type);
    if (!type) return "unknown_type";
    const resolved = await host.resolve(type);
    if (!resolved) return "no_model";

    const runId = crypto.randomUUID();
    const controller = admitSubagent(
        runId,
        host.userId,
        host.threadId,
        input.background ? undefined : host.signal
    );
    if (!controller) return "too_many";
    host.started.count += 1;

    const startedAt = Date.now();
    const steps: shared.SubagentStep[] = [];
    const base: ModelMessage[] = [
        ...(resumed?.messages ?? []),
        { role: "user", content: input.prompt }
    ];
    let messages: ModelMessage[] = base;
    let prepared: ModelMessage[] = base;
    let seen = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const output = (status: shared.SubagentStatus, summary = "", endedAt: number | null = null): shared.TaskOutput => ({
        id: runId,
        status,
        name: type.name,
        model: resolved.option.name,
        background: input.background,
        summary,
        steps: steps.slice(-shared.STEPS_LISTED),
        startedAt,
        endedAt,
        refusal: null
    });
    const tell = () => start.onProgress?.(output("running"));

    try {
        await createSubagentRun({
            id: runId,
            userId: host.userId,
            threadId: host.threadId,
            toolCallId: start.toolCallId,
            resumedFrom: resumed?.id ?? null,
            kind: type.kind,
            agentId: type.agent?.id ?? null,
            name: type.name,
            description: input.description,
            prompt: input.prompt,
            provider: resolved.option.provider,
            model: resolved.option.name,
            background: input.background
        });
    } catch (error) {
        releaseSubagent(runId);
        throw error;
    }

    const scope = {
        readOnly: type.readOnly,
        without: type.web ? new Set<string>() : host.webNames,
        mayDelegate: host.depth + 1 < shared.SUBAGENT_MAX_DEPTH
    };
    const allowed = new Set(scopedToolNames(host.tools, host.approval, scope));
    const tools = scopedTools(host.tools, host.approval, scope, {
        onStart: (tool) => {
            steps.push({ tool, state: "running", at: Date.now() });
            tell();
        },
        onEnd: (tool, ok) => {
            const open = [...steps].reverse().find((step) => step.tool === tool && step.state === "running");
            if (open) open.state = ok ? "done" : "failed";
            else steps.push({ tool, state: ok ? "done" : "failed", at: Date.now() });
            tell();
        },
        messages: () => messages
    });
    const activeFor = (found: ReadonlySet<string>) =>
        host.active(found).filter((name) => allowed.has(name) && name in tools);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(shared.SUBAGENT_TIME_MAX_MS)]);

    const finish = async (status: Exclude<shared.SubagentStatus, "running">, summary: string, failure: string | null) => {
        const text = summary.trim().slice(0, shared.SUMMARY_MAX);
        try {
            await saveSubagentProgress(runId, { steps, messages, inputTokens, outputTokens });
            await endSubagentRun(runId, { status, summary: text, failure });
        } catch (error) {
            console.error("polar: could not save a subagent's end", error);
        } finally {
            releaseSubagent(runId);
        }
        return output(status, text, Date.now());
    };

    tell();
    try {
        const result = await generateText({
            maxRetries: 0,
            model: resolved.model,
            system: systemFor(type),
            messages,
            tools,
            activeTools: activeFor(new Set()),
            stopWhen: [isStepCount(shared.SUBAGENT_STEP_MAX), tokenBudget(shared.SUBAGENT_TOKEN_MAX)],
            prepareStep: ({ stepNumber, steps: done, messages: current }) => {
                // A message the person sent it while it worked joins its
                // conversation before the next step.
                const steers = takeSteers(runId);
                prepared =
                    steers.length > 0
                        ? [
                              ...current,
                              ...steers.map((text): ModelMessage => ({ role: "user", content: text }))
                          ]
                        : current;
                const last = stepNumber >= shared.SUBAGENT_STEP_MAX - 1;
                return {
                    activeTools: activeFor(foundInSteps(done as never)),
                    ...(last ? { toolChoice: "none" as const } : {}),
                    ...(steers.length > 0 ? { messages: prepared } : {})
                } as never;
            },
            onStepFinish: async (step) => {
                inputTokens += step.usage?.inputTokens ?? 0;
                outputTokens += step.usage?.outputTokens ?? 0;
                // What this step added, after what it was sent.
                messages = [...prepared, ...step.response.messages.slice(seen)];
                seen = step.response.messages.length;
                tell();
                await saveSubagentProgress(runId, { steps, messages, inputTokens, outputTokens }).catch(
                    (error: unknown) => console.error("polar: could not save a subagent's step", error)
                );
            },
            maxOutputTokens: polarOutputTokens(resolved.option),
            abortSignal: signal
        });
        void host.spent(resolved, result.totalUsage).catch((error: unknown) =>
            console.error("polar: could not record a subagent's usage", error)
        );
        const budget = inputTokens + outputTokens >= shared.SUBAGENT_TOKEN_MAX;
        return await finish(budget && !result.text.trim() ? "budget" : "done", result.text, null);
    } catch (error) {
        if (controller.signal.aborted) return finish("stopped", "", null);
        if (signal.aborted) return finish("budget", "", null);
        const failure = classifyProviderFailure(error);
        console.warn(failureLogLine("a subagent", resolved.option.providerName, failure, error));
        return finish("failed", "", failure.kind);
    }
}
