/**
 * Answers a Quick AI question (`quick-ask.ts`) as a stream: Polar's own model
 * resolution, no tools, nothing written to a chat. The spend is recorded like
 * any helper call, and the shared key's ceilings hold. A failure reaches the
 * panel encoded the way Polar's chat encodes it, so it is named in words.
 */

import { streamText, type ModelMessage } from "ai";
import { turnSignals } from "@/lib/polar/automatic";
import type { ModelChoice } from "@/lib/polar/shared";
import { quickAskSystem, type QuickTurn } from "@/lib/polar/quick-ask";
import { localFailureOf, subscriptionFailureOf } from "@/lib/polar/claude-subscription/model";
import { classifyProviderFailure, encodePolarFailure, failureLogLine } from "@/lib/polar/provider-failure";
import { answerUsage, polarLimitReached, recordPolarUsage, routeRecord, type PolarLimitHit } from "@/lib/polar/usage";
import { answeredBy, failedTurn, reasoningFor, rememberRefusal, resolvePolarModel, type ModelRefusal } from "@/lib/polar/models";

/** Longest answer asked of the model, in tokens. */
const OUTPUT_MAX = 4000;
/** How long one quick answer may take before it gives up. */
const TIMEOUT_MS = 120_000;

export async function streamQuickAnswer(input: {
    userId: string;
    turns: readonly QuickTurn[];
    choice: ModelChoice;
    /** The request's own signal: the panel closing or Stop ends the call upstream. */
    signal: AbortSignal;
}): Promise<Response | { limit: PolarLimitHit } | ModelRefusal> {
    const resolved = await resolvePolarModel(input.userId, input.choice, turnSignals([]));
    if (typeof resolved === "string") return resolved;
    if (resolved.credential.source === "instance") {
        const hit = await polarLimitReached(input.userId);
        if (hit) return { limit: hit };
    }
    const messages: ModelMessage[] = input.turns.map((turn) => ({ role: turn.role, content: turn.text }));
    const result = streamText({
        maxRetries: 0,
        model: resolved.model,
        system: quickAskSystem(),
        messages,
        maxOutputTokens: OUTPUT_MAX,
        reasoning: reasoningFor(input.choice.intelligence, resolved.option),
        abortSignal: AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        onFinish: async ({ totalUsage }) => {
            const answered = { ...resolved, ...answeredBy(resolved) };
            try {
                await recordPolarUsage({
                    userId: input.userId,
                    threadId: null,
                    messageId: null,
                    provider: answered.option.provider,
                    model: answered.option.model,
                    payer: answered.credential.source === "instance" ? "instance" : "own",
                    usage: answerUsage(totalUsage, answered.option),
                    surface: "helper",
                    ...routeRecord(resolved)
                });
            } catch (error) {
                console.error("polar: could not record a quick answer's usage", error);
            }
        }
    });
    return result.toUIMessageStreamResponse({
        sendReasoning: false,
        // The model on screen: the one asked, then the one that answered (a
        // stand-in Automatic handed the turn to names itself).
        messageMetadata: ({ part }) =>
            part.type === "start"
                ? { model: resolved.option.name }
                : part.type === "finish"
                  ? { model: answeredBy(resolved).option.name }
                  : undefined,
        onError: (error) => {
            const subscription = subscriptionFailureOf(error);
            if (subscription) return JSON.stringify({ code: "subscription", reason: subscription });
            const local = localFailureOf(error);
            if (local) return JSON.stringify({ code: "local", reason: local.reason, server: local.server });
            const { option, credential } = failedTurn(resolved);
            const failure = classifyProviderFailure(error);
            rememberRefusal(input.userId, option.provider, failure.kind);
            console.warn(failureLogLine("a quick answer", option.providerName, failure, error));
            return encodePolarFailure({
                code: "provider",
                kind: failure.kind,
                provider: option.providerName,
                slug: option.provider,
                payer: credential.source === "instance" ? "instance" : "own"
            });
        }
    });
}
