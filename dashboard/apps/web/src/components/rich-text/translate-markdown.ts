/**
 * Written Markdown in another language, with everything that is not words left
 * exactly where it was.
 *
 * Translating the message's plain text would hand back the right words and
 * lose the rest: bold and italics, links, lists, a code block, a mention of a
 * person or a file, a space's emoji, `@everyone`. So the message is parsed with
 * the editor's own parser, only its runs of words are translated, and the
 * document is written back to Markdown the way the editor writes it. A run is
 * one text node with one set of marks; mentions are their own nodes and are
 * never sent anywhere. Code - fenced or inline - is what somebody wrote on
 * purpose and stays as written.
 */

import * as core from "@polaris/core";
import type { JSONContent } from "@tiptap/core";
import type { TranslationOutcome } from "@/lib/text-translation/queue";
import { docToMarkdown, markdownToDoc, MARKDOWN_BLOCK, splitChannelMentions } from "./markdown";

/** A piece of a text node: words to translate, or something kept as it is. */
type Piece = { readonly text: string; readonly words: boolean };

/** Something to read in it - a run of only spaces, digits or punctuation is
 *  left alone rather than sent to be "translated". */
const WORDS = /\p{L}/u;

/**
 * @param markdown - What was typed, as the composer stores it.
 * @param translate - Asks for one run of words in the target language.
 * @returns "translated" with the rebuilt Markdown, "same" when no run changed
 *   language, or "failed" when any run could not be translated - a message is
 *   never sent half in one language and half in the other.
 */
export async function translateMarkdown(
    markdown: string,
    translate: (text: string) => Promise<TranslationOutcome>
): Promise<TranslationOutcome> {
    const doc = markdownToDoc(markdown);
    const nodes: { node: JSONContent; pieces: Piece[] }[] = [];
    const walk = (node: JSONContent) => {
        if (node.type === "codeBlock" || node.type === MARKDOWN_BLOCK) return;
        if (node.type === "text") {
            if ((node.marks ?? []).some((mark) => mark.type === "code")) return;
            const pieces = piecesOf(node.text ?? "");
            if (pieces.some((piece) => piece.words)) nodes.push({ node, pieces });
            return;
        }
        for (const child of node.content ?? []) walk(child);
    };
    walk(doc);

    const asked = new Map<string, Promise<TranslationOutcome>>();
    for (const { pieces } of nodes) {
        for (const piece of pieces) {
            if (!piece.words || asked.has(piece.text)) continue;
            asked.set(
                piece.text,
                translate(piece.text).catch(() => ({ kind: "failed" as const, message: null }))
            );
        }
    }
    const outcomes = new Map<string, TranslationOutcome>();
    await Promise.all([...asked].map(async ([text, pending]) => outcomes.set(text, await pending)));

    const all = [...outcomes.values()];
    const failed = all.find((outcome) => outcome.kind === "failed");
    if (failed) return failed;
    const changed = all.filter((outcome) => outcome.kind === "translated");
    if (changed.length === 0) return { kind: "same" };

    for (const { node, pieces } of nodes) {
        node.text = pieces
            .map((piece) => {
                const outcome = piece.words ? outcomes.get(piece.text) : undefined;
                return outcome?.kind === "translated" ? outcome.text : piece.text;
            })
            .join("");
    }
    const detected = changed.find((outcome) => outcome.detected)?.detected ?? null;
    return { kind: "translated", text: docToMarkdown(doc), detected };
}

/**
 * A text node split into its words and what is kept around them: a space's
 * emoji, `@everyone`/`@here`, and the spaces at either end of a run, which a
 * translation trims and the sentence still needs between a bold word and the
 * next one.
 */
function piecesOf(text: string): Piece[] {
    const pieces: Piece[] = [];
    for (const part of core.splitCustomEmoji(text)) {
        if (part.emoji) {
            pieces.push({ text: core.customEmojiToken(part.emoji), words: false });
            continue;
        }
        for (const run of splitChannelMentions(part.text)) {
            if (run.mention) {
                pieces.push({ text: run.text, words: false });
                continue;
            }
            const [, lead = "", middle = "", tail = ""] =
                /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text) ?? [];
            if (lead) pieces.push({ text: lead, words: false });
            if (middle) pieces.push({ text: middle, words: WORDS.test(middle) });
            if (tail) pieces.push({ text: tail, words: false });
        }
    }
    return pieces;
}
