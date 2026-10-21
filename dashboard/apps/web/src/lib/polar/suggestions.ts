/**
 * The suggested next message: after an answer finishes, one short message the
 * person would plausibly send next, shown greyed in the empty composer for
 * Tab to take - the way Claude Code's prompt suggestions sit in an empty
 * input: Tab accepts into the box, typing dismisses, and Enter on the empty
 * box sends nothing (claudeissues.com/issue/57449, /issue/14500 on accidental
 * sends) - and switched off like ChatGPT's "Show follow up suggestions in
 * chats" or Open WebUI's follow-up generation toggle.
 *
 * Written behind the answer by the helper model (`helper-model.ts`): one
 * small call with the least reasoning, a short timeout, and a failure is no
 * suggestion and no word on screen. The screen asks once, after the answer
 * has finished (`GET /api/polar/threads/:id/suggestion`), so the answer's own
 * stream is never held open for it and nothing waits on it.
 *
 * Kept in this process only, per thread and for the newest answer, for a few
 * minutes - never stored. That is also why a temporary chat gets one: nothing
 * outlives the chat, and the model reads what it already read for the answer.
 *
 * Server-only.
 */

import { z } from "zod";
import { generateText, type UIMessage } from "ai";
import {
    FAILURE_PART,
    failureLogLine,
    classifyProviderFailure
} from "@/lib/polar/provider-failure";
import {
    helperMaySpend,
    helperReasoning,
    recordHelperUsage,
    type PolarHelper
} from "@/lib/polar/helper-model";

/** Longest suggestion kept, in characters. */
export const POLAR_SUGGESTION_MAX = 120;
/** More words than a next message has: an answer, not a suggestion. */
const WORDS_MAX = 20;
/** How much of each side of the last exchange the model reads. */
const EXCERPT_MAX = 1500;
/** The answer is one line; reasoning models get room for a short thought. */
const OUTPUT_MAX = 256;
/** A suggestion nobody waits for still has to give up eventually. */
export const SUGGESTION_TIMEOUT_MS = 15_000;
/** How long a suggestion is kept for the screen to ask for it. */
const KEEP_MS = 10 * 60_000;
/** Most suggestions kept at once, so the store cannot grow without end. */
const KEPT_MOST = 5_000;

const SYSTEM = [
    "You predict the next message the user will send in this chat.",
    "Reply with only that message, written as the user would type it, in the language the user wrote in.",
    "Keep it under 12 words: a natural follow-up to the assistant's last answer.",
    "No quotes, no emoji, no markdown, no explanation.",
    "If there is no natural follow-up, reply with NONE."
].join(" ");

/** Pictographs, their joiners and variation selectors, and flag letters. */
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍︎️]/gu;
const QUOTES = /^["'`‘’“”«»「」*_#>\-\s]+|["'`‘’“”«»「」*_\s]+$/g;
const LABEL = /^(?:suggestion|next message|user|sugerencia|usuario)\s*:\s*/i;

const suggestionSchema = z.string().min(2).max(POLAR_SUGGESTION_MAX);

/**
 * The model's answer as a suggestion, or null when nothing usable is left:
 * the first line only, a "Suggestion:" label, quotes, emoji and Markdown
 * markers dropped, whitespace collapsed, a trailing full stop dropped (a
 * question mark stays), and nothing longer than a next message is.
 */
export function sanitizeSuggestion(raw: string): string | null {
    const line =
        raw
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .find(Boolean) ?? "";
    const suggestion = line
        .replace(LABEL, "")
        .replace(EMOJI, "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(QUOTES, "")
        .replace(/[.。…]+$/u, "")
        .replace(QUOTES, "")
        .trim();
    if (/^none$/i.test(suggestion)) return null;
    if (suggestion.split(" ").length > WORDS_MAX) return null;
    const parsed = suggestionSchema.safeParse(suggestion);
    return parsed.success ? parsed.data : null;
}

/** The text of a message, the end of it when it is long. */
function textOf(message: UIMessage | undefined): string {
    const text = (message?.parts ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();
    return text.length > EXCERPT_MAX ? text.slice(-EXCERPT_MAX) : text;
}

/**
 * Whether this answer earns a suggestion: it finished with words of its own,
 * not a failure or a refusal written in its place, and it is not waiting for
 * the person to approve a tool - the next thing there is a button, not a
 * message.
 */
export function suggestsAfter(answer: UIMessage | undefined): boolean {
    if (!answer || answer.role !== "assistant") return false;
    if (answer.parts.some((part) => part.type === FAILURE_PART)) return false;
    const waiting = answer.parts.some(
        (part) =>
            "state" in part &&
            (part.state === "approval-requested" || part.state === "input-available")
    );
    return !waiting && textOf(answer).length > 0;
}

interface Kept {
    userId: string;
    answerId: string;
    at: number;
    job: Promise<string | null>;
}

const kept = new Map<string, Kept>();

function sweep(now: number): void {
    if (kept.size < KEPT_MOST) return;
    for (const [key, entry] of kept) if (now - entry.at > KEEP_MS) kept.delete(key);
    if (kept.size >= KEPT_MOST) kept.clear();
}

async function suggest(
    userId: string,
    threadId: string,
    messages: readonly UIMessage[],
    helper: Promise<PolarHelper | null>
): Promise<string | null> {
    const answer = messages.at(-1);
    const asked = textOf([...messages].reverse().find((message) => message.role === "user"));
    const answered = textOf(answer);
    if (!asked || !answered) return null;
    const model = await helper;
    if (!model || !(await helperMaySpend(userId, model))) return null;
    try {
        const { text, totalUsage } = await generateText({
            model: model.resolved.model,
            system: SYSTEM,
            prompt: `User:\n${asked}\n\nAssistant:\n${answered}`,
            maxOutputTokens: OUTPUT_MAX,
            reasoning: helperReasoning(model),
            abortSignal: AbortSignal.timeout(SUGGESTION_TIMEOUT_MS)
        });
        await recordHelperUsage(userId, threadId, model, totalUsage);
        return sanitizeSuggestion(text);
    } catch (error) {
        // One line, not a stack: nobody asked for this, so nobody is told.
        console.warn(
            failureLogLine(
                "suggesting a next message",
                model.resolved.option.providerName,
                classifyProviderFailure(error)
            )
        );
        return null;
    }
}

/**
 * Starts writing the suggestion for the answer that ends `messages`, without
 * holding anything up. A newer answer in the same thread replaces it.
 */
export function startPolarSuggestion(
    userId: string,
    threadId: string,
    messages: readonly UIMessage[],
    helper: Promise<PolarHelper | null>,
    now = Date.now()
): void {
    const answer = messages.at(-1);
    if (!answer || !suggestsAfter(answer)) return;
    sweep(now);
    const job = suggest(userId, threadId, messages, helper).catch((error) => {
        console.warn(
            `polar: could not suggest a next message: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    });
    kept.set(threadId, { userId, answerId: answer.id, at: now, job });
}

/**
 * The suggestion for this answer once it is written (or given up), or null:
 * another person's thread, an older answer, or one past keeping is none.
 */
export async function settledPolarSuggestion(
    userId: string,
    threadId: string,
    answerId: string,
    now = Date.now()
): Promise<string | null> {
    const entry = kept.get(threadId);
    if (!entry || entry.userId !== userId || entry.answerId !== answerId) return null;
    if (now - entry.at > KEEP_MS) {
        kept.delete(threadId);
        return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
        entry.job,
        new Promise<null>(
            (resolve) => (timer = setTimeout(() => resolve(null), SUGGESTION_TIMEOUT_MS + 1000))
        )
    ]);
    clearTimeout(timer);
    return settled;
}
