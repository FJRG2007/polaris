/**
 * A `mailto:` body, as the composer's editor reads it.
 *
 * The body of a link is plain text and the composer holds Markdown, so the
 * conversion is only right if the editor's own reader turns it back into the
 * same words and the same lines. Asserted against that reader rather than
 * against a string, because the string being tidy says nothing about what the
 * person sees.
 */

import { describe, expect, it } from "vitest";
import { plainTextToMarkdown } from "@polaris/core";
import { markdownToDoc } from "@/components/rich-text/markdown";

interface Node {
    type?: string;
    text?: string;
    content?: Node[];
}

/** What the document says, with a hard break written as a newline. */
function words(node: Node): string {
    if (node.type === "hardBreak") return "\n";
    if (typeof node.text === "string") return node.text;
    return (node.content ?? []).map(words).join("");
}

describe("a link's body in the editor", () => {
    it("keeps every character and every line", () => {
        const text = "Hi *there* [x](y)\n# not a heading\n- not a list\n1. not numbered\n2) nor this";
        const doc = markdownToDoc(plainTextToMarkdown(text), "https://polaris.test") as Node;
        const blocks = doc.content ?? [];
        expect(blocks.map((block) => block.type)).toEqual(["paragraph"]);
        expect(words(blocks[0]!)).toBe(text);
    });

    it("keeps a blank line as a new paragraph", () => {
        const doc = markdownToDoc(plainTextToMarkdown("one\n\ntwo"), "https://polaris.test") as Node;
        expect((doc.content ?? []).map((block) => words(block))).toEqual(["one", "two"]);
    });
});
