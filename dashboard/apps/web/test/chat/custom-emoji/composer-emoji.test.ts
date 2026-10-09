/**
 * A space's emoji in the box being written.
 *
 * `:` and two letters offer the space's own first, then the ordinary ones. A
 * token in a draft becomes a picture only for an emoji of the space the box
 * writes into; one from elsewhere stays the text it is, and the send turns it
 * into its name. Whatever the editor holds is written back out as the token.
 */

import { describe, expect, it } from "vitest";
import { emojiSuggestions } from "@/components/rich-text/emoji-suggestion";
import { docToMarkdown, markdownToDoc } from "@/components/rich-text/markdown";
import { CUSTOM_EMOJI_NODE, customEmojiNode, withCustomEmojiNodes } from "@/components/rich-text/custom-emoji-doc";

const WAVE = "0193b0f0-0000-7000-8000-0000000000e1";
const FOREIGN = "0193b0f0-0000-7000-8000-0000000000e3";

const entry = (id: string, name: string) => ({ id, name, animated: false, src: `/api/chat/emoji/${id}` });
const CUSTOM = [entry(WAVE, "wave"), entry("0193b0f0-0000-7000-8000-0000000000e2", "big_wave")];

describe("what `:` offers", () => {
    it("is the space's own first, names starting with it before names containing it", () => {
        const offered = emojiSuggestions("wa", CUSTOM);
        expect(offered.slice(0, 2).map((item) => (item.kind === "custom" ? item.entry.name : ""))).toEqual([
            "wave",
            "big_wave"
        ]);
        expect(offered.some((item) => item.kind === "unicode")).toBe(true);
        expect(offered.length).toBeLessThanOrEqual(10);
    });

    it("is nothing for a single character, or for punctuation", () => {
        expect(emojiSuggestions("w", CUSTOM)).toEqual([]);
        expect(emojiSuggestions("a b", CUSTOM)).toEqual([]);
    });

    it("is only the ordinary ones where the space has none", () => {
        expect(emojiSuggestions("wave", []).every((item) => item.kind === "unicode")).toBe(true);
    });
});

describe("a token in the editor", () => {
    const known = new Map([[WAVE, { id: WAVE, name: "wave", animated: false }]]);

    it("becomes the emoji for one of this space's and goes back out as the token", () => {
        const doc = withCustomEmojiNodes(markdownToDoc(`hi <:wave:${WAVE}> there`), known);
        const inline = doc.content?.[0]?.content ?? [];
        expect(inline.some((node) => node.type === CUSTOM_EMOJI_NODE)).toBe(true);
        expect(docToMarkdown(doc)).toBe(`hi <:wave:${WAVE}> there`);
    });

    it("stays text for another space's, and inside code", () => {
        const foreign = withCustomEmojiNodes(markdownToDoc(`x <:theirs:${FOREIGN}>`), known);
        expect(JSON.stringify(foreign)).not.toContain(CUSTOM_EMOJI_NODE);
        const code = withCustomEmojiNodes(markdownToDoc(`\`<:wave:${WAVE}>\``), known);
        expect(JSON.stringify(code)).not.toContain(CUSTOM_EMOJI_NODE);
    });

    it("is written as the name when its id was damaged", () => {
        const doc = {
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    content: [{ ...customEmojiNode({ id: "nope", name: "wave", animated: false }) }]
                }
            ]
        };
        expect(docToMarkdown(doc)).toBe(":wave:");
    });
});
