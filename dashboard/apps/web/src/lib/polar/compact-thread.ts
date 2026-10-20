/**
 * Writes a compaction marker into a Polar thread (`compaction.ts`): reads the
 * stored path up to a message, has the thread's model summarise it, and saves
 * the summary as a message under that one. Owner-scoped: another person's
 * thread, or a message not in it, is a thread that does not exist.
 */

import { randomUUID } from "node:crypto";
import { generateText, type UIMessage } from "ai";
import { prisma, type Prisma } from "@polaris/db";
import { turnSignals } from "@/lib/polar/automatic";
import { getPolarThread } from "@/lib/polar/threads";
import type { ModelChoice } from "@/lib/polar/shared";
import { answerUsage, recordPolarUsage, type AnswerUsage } from "@/lib/polar/usage";
import { classifyProviderFailure, failureLogLine } from "@/lib/polar/provider-failure";
import { reasoningFor, resolvePolarModel, type ModelRefusal } from "@/lib/polar/models";
import {
    keepFor,
    pathTo,
    compactionSystem,
    POLAR_SUMMARY_MAX,
    splitAtCompaction,
    compactionTranscript,
    type CompactionInfo
} from "@/lib/polar/compaction";

/** Longest summary asked of the model, in tokens. */
const OUTPUT_MAX = 4000;
/** How long a summary may take before the compaction gives up. */
const TIMEOUT_MS = 120_000;

export type CompactRefusal = "not_found" | "nothing" | "failed" | ModelRefusal;

export async function compactPolarThread(input: {
    userId: string;
    threadId: string;
    leafId: string;
    choice: ModelChoice;
    instructions: string | null;
    auto: boolean;
}): Promise<{ message: UIMessage } | CompactRefusal> {
    const thread = await getPolarThread(input.userId, input.threadId);
    if (!thread) return "not_found";
    const path = pathTo(thread.messages, input.leafId);
    if (!path) return "not_found";
    const { summary: previous, messages: since } = splitAtCompaction(path);
    const keep = keepFor(since, input.auto);
    const summarised = since.slice(0, since.length - keep);
    if (summarised.length === 0) return "nothing";

    const resolved = await resolvePolarModel(input.userId, input.choice, turnSignals(since));
    if (typeof resolved === "string") return resolved;

    let text: string;
    let spent: AnswerUsage;
    try {
        const result = await generateText({
            model: resolved.model,
            system: compactionSystem(input.instructions),
            prompt: compactionTranscript(previous, summarised),
            maxOutputTokens: OUTPUT_MAX,
            reasoning: reasoningFor("fast", resolved.option),
            abortSignal: AbortSignal.timeout(TIMEOUT_MS)
        });
        text = result.text.trim().slice(0, POLAR_SUMMARY_MAX);
        spent = answerUsage(result.totalUsage, resolved.option);
    } catch (error) {
        console.warn(
            failureLogLine(
                "compacting a chat",
                resolved.option.providerName,
                classifyProviderFailure(error)
            )
        );
        return "failed";
    }
    if (!text) return "failed";

    const compaction: CompactionInfo = { auto: input.auto, keep, at: new Date().toISOString() };
    const message: UIMessage = {
        id: randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text }],
        metadata: { compaction, model: resolved.option.name, usage: spent }
    };
    await prisma.$transaction([
        prisma.polarMessage.create({
            data: {
                id: message.id,
                threadId: input.threadId,
                parentId: input.leafId,
                role: message.role,
                parts: message.parts as unknown as Prisma.InputJsonValue,
                metadata: message.metadata as Prisma.InputJsonValue
            }
        }),
        prisma.polarThread.update({
            where: { id: input.threadId },
            data: { updatedAt: new Date() }
        })
    ]);
    try {
        await recordPolarUsage({
            userId: input.userId,
            threadId: input.threadId,
            messageId: message.id,
            provider: resolved.option.provider,
            model: resolved.option.model,
            payer: resolved.credential.source === "instance" ? "instance" : "own",
            usage: spent
        });
    } catch (error) {
        console.error("polar: could not record a compaction's usage", error);
    }
    return { message };
}
