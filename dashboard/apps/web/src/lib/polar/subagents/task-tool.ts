/**
 * `polar_task`: the tool Polar's loop starts subagents with, as Claude Code's
 * Task tool. The screen follows each run through the tool's own streamed
 * outputs, which ride the chat's run stream (`runs.ts`) like any other part;
 * the model is handed only the summary (`toModelOutput`).
 *
 * Server-only.
 */

import { tool, type ToolSet } from "ai";
import * as shared from "@/lib/polar/subagents/shared";
import { polarInputSchema } from "@/lib/polar/tool-input";
import { noticeSubagentEnd } from "@/lib/polar/run-notices";
import { typesDescription } from "@/lib/polar/subagents/types";
import { runSubagent, type SubagentHost } from "@/lib/polar/subagents/runner";

// The output is checked with `taskOutputSchema` where it is read back
// (`readTaskOutput`); as the tool's `outputSchema` it recurses past the
// compiler's depth.

/** A call that started nothing, said as a code the card translates. */
export function refusedOutput(refusal: string, name = ""): shared.TaskOutput {
    const now = Date.now();
    return { ...shared.erroredTask(), name, startedAt: now, endedAt: now, refusal };
}

const REFUSALS: Record<string, string> = {
    invalid: "The task could not be read; give it a description and a prompt.",
    per_turn: `This turn already started ${shared.SUBAGENTS_PER_TURN} subagents; do the rest yourself.`,
    too_many: `The person already has ${shared.SUBAGENTS_MAX} subagents running; wait for one or do it yourself.`,
    unknown_type: "There is no subagent type by that name; use one listed in the tool's description.",
    no_model: "None of that subagent's models can be used now; do it yourself or pick another type.",
    not_resumable: "That subagent cannot be continued: it is still running, or it is not in this chat."
};

/** What the parent model reads back: the summary, never the steps. */
export function taskModelText(output: shared.TaskOutput): string {
    if (output.refusal) return REFUSALS[output.refusal] ?? "The subagent could not start.";
    const who = `Subagent "${output.name}" (id ${output.id})`;
    if (output.status === "running")
        return `${who} is working in the background. Its result reaches you on a later turn; do not wait for it or call it again.`;
    if (output.status === "done")
        return `${who} finished. Its report:\n\n${output.summary || "(it wrote no report)"}`;
    if (output.status === "stopped") return `${who} was stopped by the person before it finished.`;
    if (output.status === "budget")
        return `${who} ran out of its step, token or time allowance.${output.summary ? ` What it had:\n\n${output.summary}` : ""}`;
    return `${who} failed before it finished; the model it ran on refused.`;
}

const DESCRIPTION = [
    "Start a subagent: another assistant that works one task on its own, with its own fresh context, and hands back only a final report.",
    "Use it for work that is independent and self-contained (research across many sources, a long multi-step job) so the conversation keeps only the outcome. Several calls in one step run in parallel.",
    "The subagent sees nothing of this conversation: put everything it needs in `prompt`, and say what its report should contain.",
    "Set `background` to keep answering while it works; its result reaches you on a later turn. To continue a finished subagent with its context kept, pass its id as `resume`.",
    "Types:"
].join("\n");

/** The task tool for a turn, or none when this depth may not delegate. */
export function polarTaskTools(host: SubagentHost): ToolSet {
    if (host.depth >= shared.SUBAGENT_MAX_DEPTH) return {};
    return {
        [shared.TASK_TOOL]: tool({
            description: `${DESCRIPTION}\n${typesDescription(host.types)}`,
            inputSchema: polarInputSchema(shared.taskInputSchema),
            toModelOutput: ({ output }) => ({
                type: "text",
                value: taskModelText(shared.readTaskOutput(output) ?? refusedOutput("invalid"))
            }),
            async *execute(raw: unknown, { toolCallId }: { toolCallId: string }): AsyncGenerator<shared.TaskOutput> {
                const parsed = shared.taskInputSchema.safeParse(raw);
                if (!parsed.success) {
                    yield refusedOutput("invalid");
                    return;
                }
                if (host.started.count >= shared.SUBAGENTS_PER_TURN) {
                    yield refusedOutput("per_turn");
                    return;
                }
                const input = parsed.data;
                let latest: shared.TaskOutput | null = null;
                let wake: (() => void) | null = null;
                const run = runSubagent(host, {
                    input,
                    toolCallId,
                    onProgress: (output) => {
                        latest = output;
                        wake?.();
                    }
                }).catch((error: unknown) => {
                    console.error("polar: a subagent could not run", error);
                    return "invalid" as const;
                });
                if (input.background) {
                    // Handed back once it has started; it tells the bell when done.
                    const first = await Promise.race([
                        run,
                        new Promise<null>((resolve) => (wake = () => resolve(null)))
                    ]);
                    if (typeof first === "string") {
                        yield refusedOutput(first, input.type);
                        return;
                    }
                    void run.then((end) => {
                        if (typeof end !== "string")
                            void noticeSubagentEnd(host.userId, host.threadId, end.name, end.status);
                    });
                    yield first ?? (latest as shared.TaskOutput | null) ?? refusedOutput("invalid");
                    return;
                }
                let settled = false;
                void run.finally(() => {
                    settled = true;
                    wake?.();
                });
                let sent: shared.TaskOutput | null = null;
                while (!settled) {
                    await new Promise<void>((resolve) => (wake = resolve));
                    if (!settled && latest && latest !== sent) {
                        sent = latest;
                        yield latest;
                    }
                }
                const end = await run;
                yield typeof end === "string" ? refusedOutput(end, input.type) : end;
            }
        })
    };
}

/** The line a turn's system prompt carries for background runs that ended. */
export function finishedBackgroundPrompt(
    finished: readonly { id: string; name: string; description: string; status: string; summary: string }[]
): string {
    if (finished.length === 0) return "";
    return [
        "Background subagents you started have ended since your last answer. Tell the person what they found where it matters:",
        ...finished.map(
            (run) =>
                `<subagent_result id="${run.id}" type="${run.name}" status="${run.status}" task="${run.description.replace(/"/g, "'")}">\n${run.summary || "(no report)"}\n</subagent_result>`
        )
    ].join("\n");
}

/**
 * The task tool with no way to run, for reading stored turns: checking an
 * older message that called it, and turning its output into what the model
 * reads (`convertToModelMessages` needs the same `toModelOutput`).
 */
export function taskToolStandIn(): ToolSet {
    return {
        [shared.TASK_TOOL]: tool({
            description: DESCRIPTION,
            inputSchema: polarInputSchema(shared.taskInputSchema),
            toModelOutput: ({ output }) => ({
                type: "text",
                value: taskModelText(shared.readTaskOutput(output) ?? refusedOutput("invalid"))
            })
        })
    };
}
