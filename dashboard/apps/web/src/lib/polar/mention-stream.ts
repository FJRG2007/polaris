/**
 * Polar's answer to a mention, read as it is written - the way Meta AI's
 * answers grow in a WhatsApp chat - instead of appearing whole after a wait.
 *
 * The model is streamed, and what it has written of the step it is on is handed
 * to `draft` a few times a second: the whole text so far each time, never a
 * piece, so a screen that missed a frame is put right by the next one. A step
 * that ends by calling tools takes back what it said (`draft("")`), since only
 * the last step is the answer. Nothing here posts anything: the answer is still
 * checked and posted by the caller, and the draft only stands in for it until
 * it lands.
 *
 * Server-only.
 */

import { streamText, type LanguageModelUsage } from "ai";

/** How often the draft is sent while text arrives: smooth to read, and a frame
 *  a few times a second at most on every screen in the conversation. */
export const DRAFT_EVERY_MS = 200;

/**
 * What of `text` may be shown while it is still being written, or null once it
 * turns out to be something nobody should read (a tool call written as words).
 *
 * An unfinished tag at the end is held back until it is finished: `<invo` is
 * the start of markup as often as it is the start of a sentence, and showing it
 * for a moment and taking it back is the flicker this avoids. Pure.
 */
export function draftable(
    text: string,
    markup: (text: string) => boolean,
    clean: (text: string) => string
): string | null {
    if (markup(text)) return null;
    const open = UNFINISHED_TAG.exec(text);
    return clean(open ? text.slice(0, open.index) : text).trim();
}

/** A tag still being written at the very end: `<`, a name, maybe attributes,
 *  no `>` yet. "a < b" is not one - a space cannot start a tag's name. */
const UNFINISHED_TAG = /<(?:\/?[A-Za-z_][\w:.-]*(?:\s[^<>]{0,300})?)?$/;

export interface StreamedAnswer {
    readonly text: string;
    readonly totalUsage: LanguageModelUsage;
}

/**
 * Run the turn streamed, sending the draft as it grows. Throws what the
 * provider failed with, as `generateText` does, so the caller reads one failure
 * the same way either way.
 */
export async function streamAnswer(
    options: Parameters<typeof streamText>[0],
    draft: (text: string) => void,
    visible: (text: string) => string | null,
    now: () => number = Date.now
): Promise<StreamedAnswer> {
    const result = streamText(options);
    // What the answer is, as `generateText` reads it: the last step's text.
    let final = "";
    let totalUsage: LanguageModelUsage | null = null;
    let step = "";
    let shown = "";
    let sentAt = 0;
    // Once a step shows markup, nothing more of it is shown.
    let spoiled = false;
    const send = (text: string) => {
        sentAt = now();
        if (text === shown) return;
        shown = text;
        draft(text);
    };
    const flush = () => {
        if (spoiled) return send("");
        const text = visible(step);
        if (text === null) spoiled = true;
        send(text ?? "");
    };
    for await (const part of result.stream) {
        if (part.type === "start-step") {
            step = "";
            spoiled = false;
        } else if (part.type === "text-delta") {
            step += part.text;
            if (now() - sentAt >= DRAFT_EVERY_MS) flush();
        } else if (part.type === "finish-step") {
            final = step;
            // Words before a tool call are not the answer: the next step is.
            if (part.finishReason === "tool-calls") step = "";
            flush();
        } else if (part.type === "finish") {
            totalUsage = part.totalUsage;
        } else if (part.type === "error") {
            throw part.error;
        }
    }
    if (!totalUsage) throw new Error("The answer ended before it finished");
    return { text: final, totalUsage };
}
