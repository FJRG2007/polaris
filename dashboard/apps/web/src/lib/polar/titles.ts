/**
 * A new Polar thread is named by the model it talks to, once, after its first
 * answer - the way LibreChat's `titleConvo` runs behind the reply and the client
 * asks `/gen_title/:id` for the result. Until then the thread carries its first
 * message, cut short, so the list shows something at once.
 *
 * The title never costs more than one small call per thread, never replaces a
 * title somebody chose, and a failure keeps the placeholder without a word on
 * screen: a missing title is not worth an error.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { POLAR_TITLE_MAX } from "@/lib/polar/shared";
import { generateText, type LanguageModel, type UIMessage } from "ai";

/** Where a thread's title came from (`PolarThread.titleSource`). */
export type TitleSource = "placeholder" | "generating" | "model" | "user";

/** How much of the conversation the model reads to name it. */
const EXCERPT_MAX = 2000;
/** The answer is a few words; reasoning models get room for a short thought. */
const OUTPUT_MAX = 256;
/** More words than a title has: a sentence, most often a refusal. */
const WORDS_MAX = 10;
/** A title nobody waits for still has to give up eventually. */
const TIMEOUT_MS = 20_000;

const SYSTEM = [
    "You name conversations for a sidebar.",
    "Reply with only a title of 3 to 6 words that says what the conversation is about.",
    "Write it in the language the user wrote in.",
    "No quotes, no emoji, no markdown, no punctuation at the end."
].join(" ");

/** Pictographs, their joiners and variation selectors, and flag letters. */
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍︎️]/gu;
const QUOTES = /^["'`‘’“”«»「」*_#\s]+|["'`‘’“”«»「」*_\s]+$/g;

const titleSchema = z.string().min(1).max(POLAR_TITLE_MAX);

/**
 * The model's answer as a title, or null when nothing usable is left: the
 * first line only, a "Title:" label, quotes, emoji and closing punctuation
 * dropped, whitespace collapsed, and no longer than a rename may be.
 */
export function sanitizeTitle(raw: string): string | null {
    const line =
        raw
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .find(Boolean) ?? "";
    let title = line
        .replace(/^title\s*:\s*/i, "")
        .replace(EMOJI, "")
        .replace(/\s+/g, " ")
        .replace(QUOTES, "")
        .replace(/[.!?,;:。！？…]+$/u, "")
        .replace(QUOTES, "")
        .trim();
    if (title.split(" ").length > WORDS_MAX) return null;
    if (title.length > POLAR_TITLE_MAX) title = title.slice(0, POLAR_TITLE_MAX).trimEnd();
    const parsed = titleSchema.safeParse(title);
    return parsed.success ? parsed.data : null;
}

/** The text of a message, for the model to read. */
function textOf(message: UIMessage | undefined): string {
    return (message?.parts ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim()
        .slice(0, EXCERPT_MAX);
}

/** Title generations still running in this process, so the browser can wait for one. */
const running = new Map<string, Promise<void>>();

/**
 * Names the thread from its first exchange, if it still carries its
 * placeholder. The claim and the write are each conditional on the source, so
 * a second turn never asks again and a rename in between always wins.
 */
export async function titlePolarThread(
    userId: string,
    threadId: string,
    model: LanguageModel,
    messages: readonly UIMessage[]
): Promise<void> {
    const { count } = await prisma.polarThread.updateMany({
        where: { id: threadId, userId, titleSource: "placeholder" },
        data: { titleSource: "generating" }
    });
    if (!count) return;
    const asked = textOf(messages.find((message) => message.role === "user"));
    const answered = textOf(messages.find((message) => message.role === "assistant"));
    if (!asked) return;
    try {
        const { text } = await generateText({
            model,
            system: SYSTEM,
            prompt: `User:\n${asked}${answered ? `\n\nAssistant:\n${answered}` : ""}`,
            maxOutputTokens: OUTPUT_MAX,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const title = sanitizeTitle(text);
        if (!title) {
            console.warn("polar: the model gave no usable title", { threadId });
            return;
        }
        await prisma.polarThread.updateMany({
            where: { id: threadId, userId, titleSource: "generating" },
            data: { title, titleSource: "model" }
        });
    } catch (error) {
        console.error("polar: could not name the thread", error);
    }
}

/** Starts naming the thread without holding anything up. */
export function startPolarTitle(
    userId: string,
    threadId: string,
    model: LanguageModel,
    messages: readonly UIMessage[]
): void {
    if (running.has(threadId)) return;
    const job = titlePolarThread(userId, threadId, model, messages)
        .catch((error) => console.error("polar: could not name the thread", error))
        .finally(() => running.delete(threadId));
    running.set(threadId, job);
}

/** The thread's title once any naming in flight has finished (or given up). */
export async function settledPolarTitle(
    userId: string,
    threadId: string
): Promise<string | null> {
    const job = running.get(threadId);
    if (job) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            job,
            new Promise((resolve) => (timer = setTimeout(resolve, TIMEOUT_MS + 1000)))
        ]);
        clearTimeout(timer);
    }
    const thread = await prisma.polarThread.findFirst({
        where: { id: threadId, userId },
        select: { title: true }
    });
    return thread?.title ?? null;
}
