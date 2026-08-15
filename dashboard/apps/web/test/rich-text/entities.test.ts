/**
 * What somebody typed is what they see.
 *
 * The Markdown parser exists to produce HTML, so it escapes on the way in: a
 * pair of quotation marks becomes `&quot;&quot;`. Polaris does not render HTML -
 * the document becomes React elements and React escapes text itself - so those
 * entities reached the screen as their own characters, and sending `""` showed
 * twelve of them.
 *
 * The direction that matters for safety is the other one, and it is asserted
 * here too: decoding produces a *text node*. React escapes it again on the way
 * to the DOM, so `<script>` decoded is five characters somebody typed, never an
 * element. This test pins the decoding; the render path is what makes it safe,
 * and it is the same path for every message in Polaris.
 */

import { describe, expect, it } from "vitest";
import { decodeEntities, docToMarkdown, markdownToDoc } from "@/components/rich-text/markdown";

/** The text of the first paragraph, which is where a typed line lands. */
function firstLine(markdown: string): string {
    const doc = markdownToDoc(markdown);
    const paragraph = doc.content?.[0];
    return (paragraph?.content ?? []).map((node) => node.text ?? "").join("");
}

describe("what the parser hands back", () => {
    it("keeps quotation marks as quotation marks", () => {
        expect(firstLine('say ""')).toBe('say ""');
        expect(firstLine("it's fine")).toBe("it's fine");
    });

    it("keeps an ampersand", () => {
        expect(firstLine("Tom & Jerry & co")).toBe("Tom & Jerry & co");
    });

    it("survives a round trip through the serializer", () => {
        const typed = 'he said "no" & left';
        expect(firstLine(docToMarkdown(markdownToDoc(typed)))).toBe(typed);
    });

    it("keeps them inside a code block, where they matter most", () => {
        const doc = markdownToDoc('```py\nprint("test")\n```');
        const block = doc.content?.[0];
        expect(block?.type).toBe("codeBlock");
        expect(block?.attrs?.language).toBe("py");
        expect((block?.content ?? []).map((node) => node.text ?? "").join("")).toBe(
            'print("test")'
        );
    });
});

describe("decoding on its own", () => {
    it("handles the entities the parser emits", () => {
        expect(decodeEntities("&amp;")).toBe("&");
        expect(decodeEntities("&lt;b&gt;")).toBe("<b>");
        expect(decodeEntities("&quot;")).toBe('"');
        expect(decodeEntities("&#39;")).toBe("'");
    });

    it("handles numeric escapes, in both bases", () => {
        expect(decodeEntities("&#65;")).toBe("A");
        expect(decodeEntities("&#x41;")).toBe("A");
    });

    it("leaves alone what is not an entity", () => {
        expect(decodeEntities("a & b")).toBe("a & b");
        expect(decodeEntities("&notreal;")).toBe("&notreal;");
        expect(decodeEntities("100% & rising")).toBe("100% & rising");
    });

    it("refuses to produce a control character", () => {
        // A decoded NUL or escape byte is not something anybody typed, and it is
        // what a payload hides in.
        expect(decodeEntities("&#0;")).toBe("&#0;");
        expect(decodeEntities("&#x1b;")).toBe("&#x1b;");
    });

    it("does not turn markup back into markup", () => {
        // Decoded, and still text. What stops it being an element is the
        // renderer, which sets it as text - this only says the characters come
        // back the way they were typed.
        expect(decodeEntities("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe(
            "<script>alert(1)</script>"
        );
    });
});
