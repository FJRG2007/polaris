/**
 * A Markdown document with a frontmatter header keeps that header byte for byte
 * through the rich editor: it is split off before the editor sees the text and
 * joined back in front of what the editor hands back.
 */

import { describe, expect, it } from "vitest";
import { joinFrontmatter, splitFrontmatter } from "@/components/rich-text/frontmatter";

describe("a document's frontmatter", () => {
    it("is split off exactly and joined back", () => {
        const text = "---\nname: review\ndescription: Checks a diff\n---\n\n# Steps\n\n1. Read it";
        const { frontmatter, body } = splitFrontmatter(text);
        expect(frontmatter).toBe("---\nname: review\ndescription: Checks a diff\n---\n");
        expect(body).toBe("# Steps\n\n1. Read it");
        expect(joinFrontmatter(frontmatter, body)).toBe(text);
    });

    it("leaves a document without one untouched", () => {
        const text = "Plain **markdown**\n\n---\n\nafter a rule";
        expect(splitFrontmatter(text)).toEqual({ frontmatter: "", body: text });
        expect(joinFrontmatter("", text)).toBe(text);
    });

    it("keeps a header with no body", () => {
        const { frontmatter, body } = splitFrontmatter("---\nname: x\n---");
        expect(body).toBe("");
        expect(joinFrontmatter(frontmatter, body)).toBe("---\nname: x\n---\n");
    });
});
