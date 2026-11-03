/**
 * Long text, cut to what one engine takes in one request and put back
 * together after. The reader never meets a length: a text of any size is
 * split at the most natural place under the cap (a blank line, a line, a
 * sentence, a word), the pieces are sent in batches each engine accepts, and
 * the answers are joined in order.
 *
 * Each piece keeps the spacing around it out of the request and puts it back
 * after, so a paragraph break never depends on the engine keeping it.
 *
 * Shared by the screen and the server.
 */

import type { EngineId } from "./schemas";

export interface EngineLimit {
    /** The most texts in one request. */
    maxTexts: number;
    /** The most characters in one request, across its texts. */
    maxChars: number;
}

/** The longest piece a text is cut into. Short enough for every engine. */
export const PIECE_MAX = 4500;

/**
 * What each engine takes in one request. DeepL: 50 texts and 128 KiB a
 * request (developers.deepl.com/docs/api-reference/translate). Google Cloud
 * Translation v2: 128 segments, 5,000 characters recommended
 * (cloud.google.com/translate/quotas). Polar: what one answer can hold. The
 * browser translates one text at a time, so only the piece size matters.
 */
export const ENGINE_LIMITS: Readonly<Record<EngineId, EngineLimit>> = {
    browser: { maxTexts: 50, maxChars: 20_000 },
    deepl: { maxTexts: 50, maxChars: 30_000 },
    google: { maxTexts: 128, maxChars: 5000 },
    polar: { maxTexts: 50, maxChars: 6000 }
};

/** What the screen sends `/api/translate` at once: under the route's caps. */
export const REQUEST_LIMIT: EngineLimit = { maxTexts: 50, maxChars: 40_000 };

const BREAKS: readonly RegExp[] = [
    /\n\s*\n/g, // a blank line
    /\n/g, // a line
    /[.!?;:。！？؟।](?:["')\]”’]*)\s/g, // a sentence
    /\s/g // a word
];

/** Where to cut `text` at or before `max`: just after the last natural break. */
function cutAt(text: string, max: number): number {
    const window = text.slice(0, max);
    for (const pattern of BREAKS) {
        let end = -1;
        for (const match of window.matchAll(pattern)) end = match.index + match[0].length;
        // A break too near the start would leave a sliver; look for a coarser one.
        if (end > max / 4) return end;
    }
    // No break at all: cut at the cap, never through a surrogate pair.
    const code = text.charCodeAt(max - 1);
    return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

/** `text` in pieces no longer than `max`, which join back into `text` exactly. */
export function splitText(text: string, max: number = PIECE_MAX): string[] {
    const pieces: string[] = [];
    let rest = text;
    while (rest.length > max) {
        const end = cutAt(rest, max);
        pieces.push(rest.slice(0, end));
        rest = rest.slice(end);
    }
    if (rest || pieces.length === 0) pieces.push(rest);
    return pieces;
}

interface Piece {
    lead: string;
    core: string;
    trail: string;
}

function pieceOf(text: string): Piece {
    const lead = /^\s*/.exec(text)?.[0] ?? "";
    const core = text.slice(lead.length).trimEnd();
    return { lead, core, trail: text.slice(lead.length + core.length) };
}

/** Indexes into `cores`, grouped into requests that fit `limit`. */
export function batchesOf(cores: readonly string[], limit: EngineLimit): number[][] {
    const batches: number[][] = [];
    let current: number[] = [];
    let chars = 0;
    cores.forEach((core, index) => {
        if (
            current.length > 0 &&
            (current.length >= limit.maxTexts || chars + core.length > limit.maxChars)
        ) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(index);
        chars += core.length;
    });
    if (current.length > 0) batches.push(current);
    return batches;
}

export interface ChunkAnswer {
    texts: string[];
    detected: string | null;
}

/**
 * `texts` translated through `send`, which is called with batches that fit
 * `limit` and must answer one text per text it was given, in order. Blank
 * texts and pieces are never sent. The first language an answer detected is
 * the one returned.
 */
export async function translateInChunks(
    texts: readonly string[],
    limit: EngineLimit,
    send: (batch: string[]) => Promise<ChunkAnswer>
): Promise<ChunkAnswer> {
    const pieceMax = Math.min(PIECE_MAX, limit.maxChars);
    const split = texts.map((text) => splitText(text, pieceMax).map(pieceOf));
    const cores: string[] = [];
    const refs: Piece[] = [];
    for (const pieces of split) {
        for (const piece of pieces) {
            if (!piece.core) continue;
            cores.push(piece.core);
            refs.push(piece);
        }
    }
    let detected: string | null = null;
    const answers: string[] = new Array<string>(cores.length);
    for (const batch of batchesOf(cores, limit)) {
        const answer = await send(batch.map((index) => cores[index]!));
        if (answer.texts.length !== batch.length) throw new Error("answer count");
        batch.forEach((index, at) => {
            answers[index] = answer.texts[at]!;
        });
        detected ??= answer.detected;
    }
    const translated = new Map<Piece, string>();
    refs.forEach((piece, index) => translated.set(piece, answers[index]!));
    return {
        texts: split.map((pieces) =>
            pieces
                .map((piece) =>
                    piece.core
                        ? `${piece.lead}${translated.get(piece)!.trim()}${piece.trail}`
                        : `${piece.lead}${piece.trail}`
                )
                .join("")
        ),
        detected
    };
}
