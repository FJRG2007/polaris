/**
 * A message said in one line.
 *
 * Used wherever a message is referred to rather than read: the bar above the
 * composer while you answer one, the quote over a reply, the name a delete
 * dialog uses. Those places used to be handed the stored Markdown, so replying
 * to a code block filled the bar with backticks and a language tag instead of
 * with the code.
 *
 * The reason this is a parse rather than a regular expression is the last group:
 * what counts as formatting and what counts as a literal asterisk is the
 * parser's decision, and a second looser copy of those rules would disagree with
 * what the message actually renders as.
 */

import { describe, expect, it } from "vitest";
import { plainExcerpt } from "../../src/components/rich-text/excerpt";

describe("a code block", () => {
    it("is the code, without the fence around it", () => {
        expect(plainExcerpt('```py\nprint("test")\n```')).toBe('print("test")');
    });

    it("is one line however many it was written over", () => {
        expect(plainExcerpt("```js\nconst a = 1\nconst b = 2\n```")).toBe("const a = 1 const b = 2");
    });
});

describe("ordinary formatting", () => {
    it("is the words, not the marks", () => {
        expect(plainExcerpt("**bold** and *italic* and ~~gone~~")).toBe("bold and italic and gone");
        expect(plainExcerpt("## A heading\n\nand a line under it")).toBe(
            "A heading and a line under it"
        );
        expect(plainExcerpt("- one\n- two")).toBe("one two");
    });

    it("is a link's text rather than its address", () => {
        expect(plainExcerpt("see [the docs](https://example.com/very/long/path)")).toBe(
            "see the docs"
        );
    });

    it("is a mention's name rather than the address behind it", () => {
        const id = "0193b0f0-0000-7000-8000-000000000001";
        expect(plainExcerpt(`ask [@Ana Ruiz](polaris:user/${id})`)).toBe("ask @Ana Ruiz");
    });

    it("says an image is an image rather than nothing at all", () => {
        // A message that is only a picture would otherwise quote as an empty
        // string, which reads as a bug rather than as a picture.
        expect(plainExcerpt("![a graph](https://example.com/a.png)")).toBe("a graph");
        expect(plainExcerpt("![](https://example.com/a.png)")).toBe("image");
    });
});

describe("length", () => {
    it("cuts on a word and says it was cut", () => {
        const excerpt = plainExcerpt("one two three four five six seven eight nine ten", 20);
        expect(excerpt.endsWith("...")).toBe(true);
        expect(excerpt.length).toBeLessThanOrEqual(23);
        expect(excerpt).not.toContain("t...");
    });

    it("cuts a long unbroken string rather than emptying it", () => {
        // A URL or a hash has no space to break on. Falling back to a hard cut
        // is better than returning an ellipsis and nothing else.
        const excerpt = plainExcerpt("a".repeat(100), 20);
        expect(excerpt).toBe(`${"a".repeat(20)}...`);
    });

    it("leaves a short one alone", () => {
        expect(plainExcerpt("hello")).toBe("hello");
    });
});

describe("nothing", () => {
    it("is nothing", () => {
        expect(plainExcerpt("")).toBe("");
        expect(plainExcerpt("   \n  ")).toBe("");
    });
});
