/**
 * A space's own emoji inside the editor's document.
 *
 * Stored Markdown carries one as the text `<:name:id>`, which is what the parse
 * hands the editor. A writing surface that knows the space's emoji turns each of
 * those into a node that draws the picture - only for the emoji it was given, so
 * a token from another space or one deleted since stays the text it is, and the
 * send path says it as its name. The node is written back out as the token.
 *
 * Pure: no editor and no DOM, so the round trip can be asserted directly.
 */

import * as core from "@polaris/core";
import type { JSONContent } from "@tiptap/core";

/** The node a custom emoji is in the editor. */
export const CUSTOM_EMOJI_NODE = "customEmoji";

/** The editor node for one emoji. */
export function customEmojiNode(ref: core.CustomEmojiRef): JSONContent {
    return { type: CUSTOM_EMOJI_NODE, attrs: { id: ref.id, name: ref.name, animated: ref.animated } };
}

/** The token one node writes, or null for a node that is not one. */
export function customEmojiNodeToken(node: JSONContent): string | null {
    if (node.type !== CUSTOM_EMOJI_NODE) return null;
    const id = String(node.attrs?.id ?? "");
    const name = String(node.attrs?.name ?? "");
    const token = core.customEmojiToken({ id, name, animated: node.attrs?.animated === true });
    // Never a token that would not read back as one: a node pasted in with a
    // damaged id is written as the name it was showing.
    return core.parseCustomEmojiToken(token) ? token : core.customEmojiFallback({ name });
}

/**
 * The document with every token for one of `known` turned into its node.
 *
 * Code is left alone, a fence and an inline span both: the characters there are
 * what somebody wrote on purpose.
 */
export function withCustomEmojiNodes(
    doc: JSONContent,
    known: ReadonlyMap<string, core.CustomEmojiRef>
): JSONContent {
    if (known.size === 0) return doc;
    const walk = (node: JSONContent): JSONContent => {
        if (node.type === "codeBlock" || !node.content) return node;
        const content: JSONContent[] = [];
        for (const child of node.content) {
            if (child.type !== "text" || (child.marks ?? []).some((mark) => mark.type === "code")) {
                content.push(walk(child));
                continue;
            }
            for (const part of core.splitCustomEmoji(child.text ?? "")) {
                const found = part.emoji ? known.get(part.emoji.id) : undefined;
                if (found) content.push({ ...customEmojiNode(found), ...(child.marks ? { marks: child.marks } : {}) });
                else {
                    const text = part.emoji ? core.customEmojiToken(part.emoji) : part.text;
                    if (text) content.push({ ...child, text });
                }
            }
        }
        return { ...node, content };
    };
    return walk(doc);
}
