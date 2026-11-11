/**
 * Rewriting a draft before it is sent: a prompt for Polar or an agent, made
 * clearer and more specific, or an email body, corrected and put in order.
 *
 * The wand in the composers (`components/polar/improve-button.tsx`), the way
 * prompt enhancers sit beside the send button in other AI composers. It runs on
 * the helper model (`helper-model.ts`): the person's pick for Polar's small
 * jobs, else Automatic's fastest, so it costs what a title costs and is paid the
 * way Polar's chats are. Nothing is stored; the answer goes back to the box it
 * came from, where the person can still edit or undo it.
 *
 * Server-only.
 */

import { generateText } from "ai";
import { cleanImproved, type ImprovePurpose } from "@/lib/polar/improve-draft";
import { PLAIN_TURN } from "@/lib/polar/automatic";
import { automaticChoice } from "@/lib/polar/shared";
import type { PolarAccess } from "@/lib/polar/access";
import { resolvePolarModel } from "@/lib/polar/models";
import { polarPreferences } from "@/lib/polar/preferences";
import { classifyProviderFailure, failureLogLine } from "@/lib/polar/provider-failure";
import {
    helperMaySpend,
    helperReasoning,
    polarHelperModel,
    recordHelperUsage
} from "@/lib/polar/helper-model";

/** A rewrite is about as long as the draft; room for that and a short thought. */
const OUTPUT_MAX = 4_096;
/** Somebody is waiting with the button spinning. */
const TIMEOUT_MS = 45_000;

const SYSTEM: Record<ImprovePurpose, string> = {
    prompt: [
        "You rewrite a message a user is about to send to an AI assistant or coding agent so it gets a better result.",
        "Keep the user's intent, facts, names, code, paths and constraints exactly; never invent requirements.",
        "Make it clear and specific: state the goal, the relevant context the user gave, and the expected output.",
        "Fix spelling and grammar. Keep it about as long as needed, not longer.",
        "Write in the same language the user wrote in.",
        "Do not answer or carry out the request. Reply with only the rewritten message, no preamble, no quotes."
    ].join(" "),
    email: [
        "You edit the body of an email the user is about to send.",
        "Correct spelling, grammar and punctuation, and make it clear, well organised and polite in the tone the user chose.",
        "Keep every fact, name, date, number, link and commitment exactly as written; never add new claims.",
        "Keep the user's language, greeting and sign-off style. Keep Markdown formatting such as lists and bold if present.",
        "Do not add a subject line or a signature.",
        "Reply with only the edited body, no preamble, no quotes."
    ].join(" ")
};

/** Why nothing came back, in words the screen turns into a sentence. */
export type ImproveRefusal = "no_model" | "limit" | "failed";

export async function improveText(
    userId: string,
    access: PolarAccess,
    input: { text: string; purpose: ImprovePurpose; subject?: string | null }
): Promise<{ text: string } | { refusal: ImproveRefusal }> {
    const fallback = await resolvePolarModel(userId, automaticChoice("fast"), PLAIN_TURN, access);
    if (typeof fallback === "string") return { refusal: "no_model" };
    const settings = await polarPreferences(userId).catch(() => null);
    const helper = await polarHelperModel(userId, fallback, settings?.helperModel ?? null, access);
    if (!(await helperMaySpend(userId, helper))) return { refusal: "limit" };

    const subject = input.subject?.trim();
    const prompt =
        input.purpose === "email" && subject
            ? `Subject (context only, do not repeat it): ${subject}\n\nBody:\n${input.text}`
            : input.text;
    try {
        const { text, totalUsage } = await generateText({
            // The router retries and walks keys and fallbacks itself.
            maxRetries: 0,
            model: helper.resolved.model,
            system: SYSTEM[input.purpose],
            prompt,
            maxOutputTokens: OUTPUT_MAX,
            reasoning: helperReasoning(helper),
            abortSignal: AbortSignal.timeout(TIMEOUT_MS)
        });
        await recordHelperUsage(userId, null, helper, totalUsage);
        const improved = cleanImproved(text);
        return improved ? { text: improved } : { refusal: "failed" };
    } catch (error) {
        console.warn(
            failureLogLine(
                "improving a draft",
                helper.resolved.option.providerName,
                classifyProviderFailure(error)
            )
        );
        return { refusal: "failed" };
    }
}
