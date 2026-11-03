/**
 * One translation through the engines the screen can use: the chosen one, or
 * each in the administrator's order until one answers. Text of any length is
 * cut to what each engine takes at once (`model/chunk.ts`), so every mode -
 * typed text, a picture's lines, a document's paragraphs, a transcript - goes
 * through here and none of them meets a length.
 */

import type { EngineId } from "../model/schemas";
import { ServerEngineError } from "./server-engine";
import type { TranslateEngine } from "../model/engines";
import { ENGINE_LIMITS, REQUEST_LIMIT, translateInChunks } from "../model/chunk";

export interface RunAnswer {
    texts: string[];
    detected: string | null;
    engine: EngineId;
}

/** Translates `texts` for a mode; throws an Error carrying the sentence to show. */
export type Translate = (
    texts: string[],
    signal?: AbortSignal,
    /** Another direction than the language bar's: the other side of a conversation. */
    pair?: { from: string | null; to: string }
) => Promise<RunAnswer>;

export interface RunOptions {
    engines: ReadonlyMap<EngineId, TranslateEngine>;
    /** Tried in this order; the first that answers wins. */
    order: readonly EngineId[];
    from: string | null;
    to: string;
    /** The administrator's limit on one translation, or null. */
    charLimit: number | null;
    /** Said when no engine said anything better. */
    fallback: string;
    /** Said when the text is over the limit. */
    overLimit: (limit: number) => string;
}

export async function runTranslation(
    texts: readonly string[],
    options: RunOptions,
    signal?: AbortSignal
): Promise<RunAnswer> {
    const total = texts.reduce((sum, text) => sum + text.length, 0);
    if (options.charLimit !== null && total > options.charLimit) {
        throw new Error(options.overLimit(options.charLimit));
    }
    let lastError: string | null = null;
    for (const id of options.order) {
        const engine = options.engines.get(id);
        if (!engine) continue;
        try {
            // The browser takes a piece at a time; the server, what its route accepts.
            const limit = id === "browser" ? ENGINE_LIMITS.browser : REQUEST_LIMIT;
            const answer = await translateInChunks(texts, limit, (batch) =>
                engine.translate(batch, options.from, options.to, signal)
            );
            return { texts: answer.texts, detected: answer.detected, engine: id };
        } catch (caught) {
            if (signal?.aborted) throw caught;
            // Only the server words its refusals for the reader.
            lastError = caught instanceof ServerEngineError ? caught.message : lastError;
        }
    }
    throw new Error(lastError ?? options.fallback);
}
