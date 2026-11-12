/**
 * Rewriting a draft before it is sent: a prompt for Polar or an agent, made
 * clearer and more specific, or an email body, a task's text or any other
 * text, corrected and put in order - signed with the writer's own name, and
 * with a `{{field}}` where only the writer knows the value
 * (`improve-draft.ts`, `writing-profile.ts`).
 *
 * The wand in the composers (`components/polar/improve-button.tsx`), the way
 * prompt enhancers sit beside the send button in other AI composers. It runs on
 * the person's pick for Improve, else their pick for Polar's small jobs
 * (`helper-model.ts`), else Automatic's fastest, so it costs what a title
 * costs and is paid the way Polar's chats are. Nothing is stored; the answer goes back to the box it
 * came from, where the person can still edit or undo it.
 *
 * Server-only.
 */

import { generateText } from "ai";
import type { SessionUser } from "@/lib/session";
import { writingProfile } from "@/lib/polar/writing-profile";
import { cleanImproved, improveSystem, type ImprovePurpose } from "@/lib/polar/improve-draft";
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

/** Why nothing came back, in words the screen turns into a sentence. */
export type ImproveRefusal = "no_model" | "limit" | "failed";

export async function improveText(
    user: Pick<SessionUser, "id" | "name" | "email">,
    access: PolarAccess,
    input: {
        text: string;
        purpose: ImprovePurpose;
        subject?: string | null;
        /** The organization the text belongs to, when it does. */
        orgId?: string | null;
    }
): Promise<{ text: string } | { refusal: ImproveRefusal }> {
    const userId = user.id;
    const fallback = await resolvePolarModel(userId, automaticChoice("fast"), PLAIN_TURN, access);
    if (typeof fallback === "string") return { refusal: "no_model" };
    const settings = await polarPreferences(userId).catch(() => null);
    // Improve's own pick, else the helper model's: both default to the cheap one.
    const chosen = settings?.improveModel ?? settings?.helperModel ?? null;
    const [helper, profile] = await Promise.all([
        polarHelperModel(userId, fallback, chosen, access),
        // A profile that cannot be read is a rewrite without it, not a failure.
        writingProfile(user, input.orgId ?? null, settings).catch(() => ({
            writer: { name: user.name, email: user.email },
            org: null,
            context: "",
            skills: []
        }))
    ]);
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
            system: improveSystem(input.purpose, profile),
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
