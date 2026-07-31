/**
 * Highlighting. The output goes into the page as markup, so the load-bearing
 * property is that highlight.js escapes what it is given: a file that contains
 * a script tag must come out as text, never as a tag. The rest pins that a
 * grammar is only used once it is loaded, and that a file too big to tokenize
 * falls back to plain text rather than freezing the editor on every keystroke.
 */

import { describe, expect, it } from "vitest";
import {
    HIGHLIGHT_LIMIT,
    loadHighlighter
} from "../../../src/app/(app)/drive/viewer/code-highlight";

describe("loadHighlighter", () => {
    it("marks up the languages it was asked for", async () => {
        const highlight = await loadHighlighter(["json", "css"]);
        const json = highlight('{"name": "polaris"}', "json");
        expect(json).toContain("hljs-attr");
        expect(json).toContain("hljs-string");
        expect(highlight("a { color: red; }", "css")).toContain("hljs-attribute");
    });

    it("resolves a fence tag through the same table as an extension", async () => {
        const highlight = await loadHighlighter(["yml"]);
        expect(highlight("key: value", "yaml")).toContain("hljs-attr");
    });

    it("escapes the source instead of letting it become markup", async () => {
        const highlight = await loadHighlighter(["html"]);
        const painted = highlight('<script>alert("x")</script>', "html");
        expect(painted).not.toContain("<script>");
        expect(painted).toContain("&lt;");
    });

    it("leaves a language it never loaded unhighlighted", async () => {
        const highlight = await loadHighlighter(["json"]);
        expect(highlight("SELECT 1", "sql")).toBeNull();
        expect(highlight("hello", "not-a-language")).toBeNull();
    });

    it("gives up on a file too big to tokenize", async () => {
        const highlight = await loadHighlighter(["json"]);
        expect(highlight(`"${"x".repeat(HIGHLIGHT_LIMIT)}"`, "json")).toBeNull();
    });

    it("has nothing to load when a document fences no known language", async () => {
        const highlight = await loadHighlighter([]);
        expect(highlight('{"a": 1}', "json")).toBeNull();
    });
});
