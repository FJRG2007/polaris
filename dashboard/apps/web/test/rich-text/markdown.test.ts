/**
 * The Markdown bridge is what keeps rich text portable: everything the editor
 * shows has to survive being written out and read back. These tests are the
 * round trip, one construct at a time, plus the two cases that decide whether
 * the format is safe to store - a reference keeping its address, and text that
 * looks like formatting not becoming formatting.
 */

import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { docToMarkdown, isBlankMarkdown, markdownToDoc } from "@/components/rich-text/markdown";

/** What the editor would store after loading `source` and saving it untouched. */
function roundTrip(source: string): string {
    return docToMarkdown(markdownToDoc(source));
}

describe("markdown round trip", () => {
    it.each([
        ["a heading", "## What needs doing"],
        ["emphasis", "Some **bold**, some *italic*, some ~~gone~~."],
        ["inline code", "Run `npm test` first."],
        ["a link", "See [the runbook](https://example.com/runbook)."],
        ["a bullet list", "- first\n- second"],
        ["an ordered list", "1. first\n2. second"],
        ["a checklist", "- [ ] open\n- [x] done"],
        ["a quote", "> what somebody said"],
        ["a fenced block", "```ts\nconst value = 1;\n```"],
        ["a rule", "---"],
        ["an image", "![a screenshot](https://example.com/shot.png)"],
        ["several blocks", "# Title\n\nA paragraph.\n\n- one\n- two"]
    ])("keeps %s", (_name, source) => {
        expect(roundTrip(source)).toBe(source);
    });

    it("keeps a nested list indented under its parent", () => {
        const source = "- outer\n  - inner\n- next";
        expect(roundTrip(source)).toBe(source);
    });

    it("carries a table through untouched rather than dropping it", () => {
        const source = "| a | b |\n| --- | --- |\n| 1 | 2 |";
        expect(roundTrip(source)).toBe(source);
    });

    it("does not turn text that looks like formatting into formatting", () => {
        const doc = markdownToDoc("");
        doc.content = [{ type: "paragraph", content: [{ type: "text", text: "2 * 3 * 4 [not a link]" }] }];
        const written = docToMarkdown(doc);
        expect(roundTrip(written)).toBe(written);
        const reread = (markdownToDoc(written).content?.[0]?.content ?? []).map((node) => node.text ?? "").join("");
        expect(reread).toBe("2 * 3 * 4 [not a link]");
    });

    it("empties to nothing rather than to a stray paragraph", () => {
        expect(roundTrip("")).toBe("");
        expect(roundTrip("   \n\n  ")).toBe("");
    });
});

describe("references", () => {
    const id = "0193b0f0-0000-7000-8000-000000000001";

    it("reads a mention back as a reference node, not a link", () => {
        const doc = markdownToDoc(`Ping [@Ana Ruiz](polaris:user/${id}) about it.`);
        const nodes = doc.content?.[0]?.content ?? [];
        const mention = nodes.find((node) => node.type === "reference");
        expect(mention?.attrs).toEqual({ kind: "user", id, label: "Ana Ruiz" });
    });

    it("writes a mention back with its sigil and address", () => {
        const source = `Ping [@Ana Ruiz](polaris:user/${id}) about it.`;
        expect(roundTrip(source)).toBe(source);
    });

    it("keeps a task reference addressable", () => {
        const source = `Blocked by [Fix the edge cert](polaris:task/${id}).`;
        expect(roundTrip(source)).toBe(source);
    });

    it("turns a pasted link to this Polaris into a chip", () => {
        const doc = markdownToDoc(
            `[PLR-42](https://polaris.example.com/tasks/t/${id})`,
            "https://polaris.example.com"
        );
        expect(doc.content?.[0]?.content?.[0]).toEqual({
            type: "reference",
            attrs: { kind: "task", id, label: "PLR-42" }
        });
    });

    it("leaves a link to somewhere else alone", () => {
        const source = "[a task elsewhere](https://other.example.com/tasks/t/1)";
        expect(roundTrip(source)).toBe(source);
    });

    it("ignores an address whose id is not one", () => {
        const source = "[not a mention](polaris:user/whoever)";
        expect(roundTrip(source)).toBe(source);
    });
});

/**
 * A message that is only whitespace.
 *
 * The one that got out: a few spaces, shift-enter, a few more spaces. Every
 * guard in the way asked whether the *source* was empty, and the source was a
 * lone backslash - the hard break at the end of the last line, with nothing
 * after it to break. So a message reading `\` landed in the room.
 */
describe("nothing to send", () => {
    const doc = (content: JSONContent[]): JSONContent => ({
        type: "doc",
        content: [{ type: "paragraph", content }]
    });

    it("writes no trailing break for a line with nothing after it", () => {
        expect(
            docToMarkdown(
                doc([{ type: "text", text: "   " }, { type: "hardBreak" }, { type: "text", text: "  " }])
            )
        ).toBe("");
    });

    it("keeps a break that has something after it", () => {
        expect(
            docToMarkdown(
                doc([{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }])
            )
        ).toBe("one\\\ntwo");
    });

    it("keeps a backslash somebody typed", () => {
        expect(isBlankMarkdown(docToMarkdown(doc([{ type: "text", text: "\\" }])))).toBe(false);
    });

    it.each([
        ["nothing at all", ""],
        ["spaces", "   "],
        ["a stray hard break", "\\"],
        ["several", "\\\n\\\n  \\"],
        ["blank lines", "\n\n\n"]
    ])("refuses %s", (_case, source) => {
        expect(isBlankMarkdown(source)).toBe(true);
    });

    it.each([
        ["a word", "hello"],
        ["a picture", "![](https://example.com/a.png)"],
        ["a mention", "[@Javier](polaris:user/018f0000-0000-7000-8000-000000000000)"],
        ["an empty code fence", "```\n\n```"]
    ])("allows %s", (_case, source) => {
        expect(isBlankMarkdown(source)).toBe(false);
    });
});
