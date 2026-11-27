/**
 * Answers a `/btw` side question (`btw.ts`): one call to the chat's own model
 * with no tools, its words handed back and nothing written to the thread. The
 * spend is recorded like any helper call, and the shared key's ceilings hold.
 */

import { generateText } from "ai";
import { prisma } from "@polaris/db";
import { turnSignals } from "@/lib/polar/automatic";
import type { ModelChoice } from "@/lib/polar/shared";
import { classifyProviderFailure, failureLogLine } from "@/lib/polar/provider-failure";
import { answeredBy, reasoningFor, resolvePolarModel, type ModelRefusal } from "@/lib/polar/models";
import { answerUsage, polarLimitReached, recordPolarUsage, routeRecord, type PolarLimitHit } from "@/lib/polar/usage";
import { btwPrompt, btwSystem, replayed, POLAR_BTW_ANSWER_MAX, type BtwExchange } from "@/lib/polar/btw";

/** Longest answer asked of the model, in tokens. */
const OUTPUT_MAX = 2000;
/** How long a side question may take before it gives up. */
const TIMEOUT_MS = 90_000;

export type BtwRefusal = "failed" | ModelRefusal;

export async function answerSideQuestion(input: {
    userId: string;
    threadId: string | null;
    question: string;
    context: string;
    earlier: readonly BtwExchange[];
    choice: ModelChoice;
}): Promise<{ answer: string; model: string } | { limit: PolarLimitHit } | BtwRefusal> {
    const resolved = await resolvePolarModel(input.userId, input.choice, turnSignals([]));
    if (typeof resolved === "string") return resolved;
    if (resolved.credential.source === "instance") {
        const hit = await polarLimitReached(input.userId);
        if (hit) return { limit: hit };
    }
    try {
        // No `tools`: a side question answers only from what is already in
        // context, as Claude Code's does.
        const result = await generateText({
            maxRetries: 0,
            model: resolved.model,
            system: btwSystem(),
            prompt: btwPrompt(input.context, replayed(input.earlier), input.question),
            maxOutputTokens: OUTPUT_MAX,
            reasoning: reasoningFor("fast", resolved.option),
            abortSignal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const answer = result.text.trim().slice(0, POLAR_BTW_ANSWER_MAX);
        if (!answer) return "failed";
        const answered = { ...resolved, ...answeredBy(resolved) };
        try {
            // Spend lands on the chat only when it is the caller's own.
            const owned =
                input.threadId !== null &&
                (await prisma.polarThread.count({ where: { id: input.threadId, userId: input.userId } })) > 0;
            await recordPolarUsage({
                userId: input.userId,
                threadId: owned ? input.threadId : null,
                messageId: null,
                provider: answered.option.provider,
                model: answered.option.model,
                payer: answered.credential.source === "instance" ? "instance" : "own",
                usage: answerUsage(result.totalUsage, answered.option),
                surface: "helper",
                ...routeRecord(resolved)
            });
        } catch (error) {
            console.error("polar: could not record a side question's usage", error);
        }
        return { answer, model: answered.option.name };
    } catch (error) {
        console.warn(
            failureLogLine("answering a side question", resolved.option.providerName, classifyProviderFailure(error), error)
        );
        return "failed";
    }
}
