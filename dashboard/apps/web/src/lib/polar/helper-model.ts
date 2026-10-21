/**
 * The model Polar's small jobs run on: the thread's title and the suggested
 * next message - the extras around a chat that are not its answer.
 *
 * The person picks one in Polar's settings or leaves it on Automatic, the way
 * Open WebUI's "Task model" (`TASK_MODEL`, docs.openwebui.com/features/
 * administration/task-models) and LibreChat's `titleModel`
 * (librechat.ai/docs/configuration/librechat_yaml/object_structure/
 * shared_endpoint_settings) run titles and follow-ups on a separate, smaller
 * model. Automatic is the first model Polar's own Automatic would send a quick
 * plain question to (`automatic.ts`, the "fast" ordering: no reasoning, then
 * cheapest). A chosen model whose key has gone, or that the catalogue no
 * longer carries, falls back to Automatic without a word - the settings show
 * that state - and when nothing else can be served the chat's own model does
 * the job, as Open WebUI falls back to the current chat model.
 *
 * Compaction is not a small job and stays on the chat's model: its summary
 * replaces the history the next answers are written from, so a weaker model
 * there loses what the conversation depends on.
 *
 * Server-only.
 */

import type { LanguageModelUsage } from "ai";
import { PLAIN_TURN } from "@/lib/polar/automatic";
import { automaticChoice } from "@/lib/polar/shared";
import type { PolarAccess } from "@/lib/polar/access";
import type { PolarHelperModel } from "@/lib/polar/display";
import { answerUsage, polarLimitReached, recordPolarUsage } from "@/lib/polar/usage";
import { reasoningFor, resolvePolarModel, type ResolvedModel } from "@/lib/polar/models";

/** Where the helper came from: the person's pick, Automatic, or the chat. */
export type HelperSource = "chosen" | "automatic" | "chat";

export interface PolarHelper {
    resolved: ResolvedModel;
    source: HelperSource;
}

/**
 * The model a small job runs on for this person: their pick when it can be
 * served, else Automatic's fastest, else the chat's own model.
 */
export async function polarHelperModel(
    userId: string,
    chat: ResolvedModel,
    chosen: PolarHelperModel | null,
    access?: PolarAccess
): Promise<PolarHelper> {
    if (chosen) {
        const picked = await resolvePolarModel(
            userId,
            { kind: "language", ...chosen, intelligence: "fast" },
            PLAIN_TURN,
            access
        );
        if (typeof picked !== "string") return { resolved: picked, source: "chosen" };
    }
    const automatic = await resolvePolarModel(userId, automaticChoice("fast"), PLAIN_TURN, access);
    if (typeof automatic !== "string") return { resolved: automatic, source: "automatic" };
    return { resolved: chat, source: "chat" };
}

/** The least reasoning the helper takes, or none for a model that does not reason. */
export function helperReasoning(helper: PolarHelper) {
    return reasoningFor("fast", helper.resolved.option);
}

/**
 * Whether the helper may spend now: a job on the key this Polaris shares
 * stops at the administrator's ceilings, as a turn does. A person's own key
 * is never capped here.
 */
export async function helperMaySpend(userId: string, helper: PolarHelper): Promise<boolean> {
    if (helper.resolved.credential.source !== "instance") return true;
    return !(await polarLimitReached(userId));
}

/** Records what a small job spent, under the thread, with no message of its own. */
export async function recordHelperUsage(
    userId: string,
    threadId: string,
    helper: PolarHelper,
    usage: LanguageModelUsage | undefined
): Promise<void> {
    const { option, credential } = helper.resolved;
    try {
        await recordPolarUsage({
            userId,
            threadId,
            messageId: null,
            provider: option.provider,
            model: option.model,
            payer: credential.source === "instance" ? "instance" : "own",
            usage: answerUsage(usage, option)
        });
    } catch (error) {
        console.error("polar: could not record a small job's usage", error);
    }
}
