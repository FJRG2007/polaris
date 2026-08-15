/**
 * A line of written text, said in one line.
 *
 * Wanted wherever a message has to be referred to rather than read: the bar
 * above the composer while you answer one, the quote over a reply, the sentence
 * a delete dialog names. Those places had the stored Markdown put straight into
 * them, which is fine until somebody replies to a code block and the bar reads
 *
 *     Replying to Javier ```py print("test") ```
 *
 * - three backticks, a language tag and a fence, none of which is what was said.
 * The same goes for a heading's hashes, a list's dashes, a link's brackets and
 * the address inside them.
 *
 * So the Markdown is parsed with the parser the editor already uses and walked
 * for its text. That is deliberately not a regular expression over the source:
 * the rules for what is formatting and what is a literal asterisk are the
 * parser's, and a second, looser copy of them would disagree with what the
 * message actually renders as.
 *
 * What comes out is text and only text. It is never markup and is escaped by
 * whatever draws it, the same as any other string in Polaris.
 */

import { chipLabel } from "./chip";
import type { JSONContent } from "@tiptap/core";
import type { ReferenceKind } from "./references";
import { markdownToDoc, MARKDOWN_BLOCK, REFERENCE } from "./markdown";

/** What stands in for a block that has no words in it. */
const IMAGE = "image";

/**
 * One line of plain text from stored Markdown.
 *
 * @param markdown - What was written.
 * @param max - How many characters to keep. Past it the line is cut on a word
 *   and given an ellipsis, since cutting mid-word reads as a broken string
 *   rather than a shortened one.
 */
export function plainExcerpt(markdown: string, max = 120): string {
    const flat = collapse(textOf(markdownToDoc(markdown ?? "")));
    if (flat.length <= max) return flat;
    const cut = flat.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    // Only break on a word when there is a word to break on: a long unbroken
    // string - a URL, a hash - has no space and is better cut than emptied.
    return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/**
 * A whole message as plain text, for taking somewhere else.
 *
 * The same walk as the excerpt, and for the same reason - what is stored is
 * Markdown, and Markdown carries escapes. Copying the source hands somebody
 * `print\("test"\)` for a line that reads `print("test")`, and pasting that
 * into a terminal is somebody's afternoon. Lines are kept, so a code block
 * arrives as code rather than as one long line.
 */
export function plainText(markdown: string): string {
    return blocksOf(markdownToDoc(markdown ?? ""))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** The block-level nodes whose children are separate lines. Everything else is
 *  inline and runs together. */
const STACKED = new Set(["doc", "bulletList", "orderedList", "listItem", "blockquote", "taskList", "taskItem"]);

function blocksOf(node: JSONContent): string {
    if (node.type === "text") return node.text ?? "";
    if (node.type === REFERENCE) {
        return chipLabel(node.attrs?.kind as ReferenceKind, String(node.attrs?.label ?? ""));
    }
    if (node.type === "hardBreak") return "\n";
    if (node.type === IMAGE) return String(node.attrs?.alt ?? "").trim() || IMAGE;
    // Code holds its source as one text node, newlines and all. Kept exactly,
    // because the whole point of copying a code block is that it runs.
    if (node.type === "codeBlock" || node.type === MARKDOWN_BLOCK) {
        return (node.content ?? []).map((child) => child.text ?? "").join("");
    }
    const parts = (node.content ?? []).map(blocksOf);
    return STACKED.has(node.type ?? "") ? parts.join("\n") : parts.join("");
}

/** Every run of whitespace becomes one space, so a fence spanning eight lines
 *  becomes one line rather than eight squeezed into a row. */
function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function textOf(node: JSONContent): string {
    if (node.type === "text") return node.text ?? "";
    // A mention reads as the name it carries, not as the address behind it, and
    // through the same function the chip uses so it reads the same in the quote
    // as it does in the message - the @ included.
    if (node.type === REFERENCE) {
        return chipLabel(node.attrs?.kind as ReferenceKind, String(node.attrs?.label ?? ""));
    }
    if (node.type === "hardBreak") return " ";
    if (node.type === IMAGE) return String(node.attrs?.alt ?? "").trim() || "image";
    // A code block and a carried-through piece of Markdown both hold their
    // source as text, which is exactly what should be shown: the code, without
    // the fence around it.
    if (node.type === "codeBlock" || node.type === MARKDOWN_BLOCK) {
        return (node.content ?? []).map((child) => child.text ?? "").join(" ");
    }
    // A space between blocks, so a heading does not run into the paragraph
    // under it.
    return (node.content ?? []).map((child) => `${textOf(child)} `).join("");
}
