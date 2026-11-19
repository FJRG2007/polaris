/**
 * Polar answering because somebody named it - in a Chat conversation or in a
 * task's thread.
 *
 * The answer is the asker's: their Polar access, their models and keys, their
 * limits on the shared key, and the usage is recorded against them exactly as a
 * turn in the Polar panel is. When they cannot use Polar - no access, no
 * provider key reachable, the shared key's limit reached - what comes back is
 * the sentence that says so, with the link that fixes it, so the caller posts
 * that instead of staying silent.
 *
 * No tools: the place is shared, and a tool would act in the asker's name in
 * front of everybody there. Server-only.
 */

import { generateText } from "ai";
import type { chatWordsFor } from "@/lib/chat/text";

type Words = Awaited<ReturnType<typeof chatWordsFor>>;

/** The longest answer, in tokens; a reply in a thread is not a report. */
const ANSWER_TOKENS = 2_048;
/** How often the caller is asked to show Polar writing. */
const TYPING_EVERY_MS = 2_500;

export interface MentionTurn {
    readonly userId: string;
    readonly words: Words;
    readonly system: string;
    readonly prompt: string;
    /** Where it is recorded and named in a log line. */
    readonly where: string;
    /** Shown while it writes, repeated until it is done. */
    readonly typing?: () => void;
}

/** What Polar says when no model can answer for this person, with the way to fix it. */
export function noProviderText(words: Words, spendsShared: boolean): string {
    return [
        words(spendsShared ? "polar.noProvider" : "polar.noProviderOwnOnly"),
        `[${words("polar.addKey")}](/polar/settings/providers)`
    ].join(" ");
}

/** Why there is no answer, for a caller that offers the way out under it. */
export type MentionProblem = "notAvailable" | "tooFast" | "noProvider" | "limitReached" | "failed";

export interface MentionAnswer {
    readonly text: string;
    /** Null when Polar answered. */
    readonly problem: MentionProblem | null;
}

/** Polar's answer to one mention, or the sentence that says why there is none. Never throws for a model failure. */
export async function answerMention(turn: MentionTurn): Promise<string> {
    return (await answerMentionWithReason(turn)).text;
}

/** The same, saying why when there is no answer. */
export async function answerMentionWithReason(turn: MentionTurn): Promise<MentionAnswer> {
    const { userId, words } = turn;
    const fail = (problem: MentionProblem, text: string): MentionAnswer => ({ text, problem });
    const [{ polarAccessFor }, { rateLimit }] = await Promise.all([
        import("@/lib/polar/access"),
        import("@/lib/rate-limit-service")
    ]);
    const access = await polarAccessFor(userId);
    if (!access.use) return fail("notAvailable", words("polar.notAvailable"));
    // The panel's own ceiling: a mention is a Polar turn like any other.
    const allowed = await rateLimit(`polar-chat:${userId}`, 30, 60_000);
    if (!allowed.ok) return fail("tooFast", words("polar.tooFast"));

    const [{ resolvePolarModel, answeredBy }, { automaticChoice }, { PLAIN_TURN }, usage] = await Promise.all([
        import("@/lib/polar/models"),
        import("@/lib/polar/shared"),
        import("@/lib/polar/automatic"),
        import("@/lib/polar/usage")
    ]);
    const resolved = await resolvePolarModel(userId, automaticChoice(), PLAIN_TURN, access);
    if (typeof resolved === "string") return fail("noProvider", noProviderText(words, access.spend));
    if (resolved.credential.source === "instance" && (await usage.polarLimitReached(userId))) {
        return fail("limitReached", words("polar.limitReached"));
    }

    turn.typing?.();
    const dots = turn.typing ? setInterval(turn.typing, TYPING_EVERY_MS) : null;
    let text: string;
    let spent: Parameters<typeof usage.answerUsage>[0];
    try {
        const answer = await generateText({
            // The router retries and walks keys and fallbacks itself.
            maxRetries: 0,
            model: resolved.model,
            maxOutputTokens: ANSWER_TOKENS,
            system: turn.system,
            prompt: turn.prompt
        });
        text = answer.text;
        spent = answer.totalUsage;
    } catch (error) {
        const { classifyProviderFailure, failureLogLine } = await import("@/lib/polar/provider-failure");
        console.warn(failureLogLine(turn.where, resolved.option.providerName, classifyProviderFailure(error), error));
        return fail("failed", words("polar.failed"));
    } finally {
        if (dots) clearInterval(dots);
    }

    const answered = answeredBy(resolved);
    try {
        await usage.recordPolarUsage({
            userId,
            threadId: null,
            messageId: null,
            provider: answered.option.provider,
            model: answered.option.model,
            payer: answered.credential.source === "instance" ? "instance" : "own",
            usage: usage.answerUsage(spent, answered.option),
            ...usage.routeRecord(resolved)
        });
    } catch (error) {
        console.error(`polar: could not record the usage of ${turn.where}:`, error);
    }
    const { withoutPseudoToolCalls } = await import("@/lib/polar/pseudo-tools");
    const said = withoutPseudoToolCalls(text).trim();
    return said ? { text: said, problem: null } : fail("failed", words("polar.failed"));
}

/** The question with the mention taken out; empty when only the mention was written. */
export function questionOf(body: string): string {
    return body.replace(/(^|[^\w@])@polar(?![\w-])/gi, "$1").trim();
}
