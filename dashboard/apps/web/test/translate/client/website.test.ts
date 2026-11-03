// @vitest-environment jsdom

/**
 * A fetched page read inert: only text leaves it, in order, with structure,
 * and only http(s) links - nothing of the page's HTML or scripts is kept.
 */

import { describe, expect, it } from "vitest";
import { BLOCKS_MAX, readHtml, safeHref } from "@polaris-app/translate/src/screens/website";

const BASE = "https://example.com/news/";

describe("readHtml", () => {
    it("keeps headings, paragraphs, list items, quotes and code in reading order", () => {
        const page = readHtml(
            `<html><head><title> The  news </title><style>p{}</style></head><body>
            <h1>Hello</h1><p>First <b>bold</b> line.</p>
            <ul><li>One</li><li>Two</li></ul>
            <blockquote>Said</blockquote><pre>a\n  b</pre>
            <table><tr><th>Name</th><td>Value</td></tr></table>
            </body></html>`,
            BASE
        );
        expect(page.title).toBe("The news");
        expect(page.blocks.map((block) => [block.tag, block.text])).toEqual([
            ["h1", "Hello"],
            ["p", "First bold line."],
            ["li", "One"],
            ["li", "Two"],
            ["quote", "Said"],
            ["pre", "a\n  b"],
            ["cell", "Name"],
            ["cell", "Value"]
        ]);
    });

    it("drops scripts, styles, forms, hidden parts and markup", () => {
        const page = readHtml(
            `<body><script>alert(1)</script><p onclick="x()">Safe<img src=x onerror=alert(1)></p>
            <div hidden>Secret</div><div aria-hidden="true">Icon</div>
            <p style="display:none">Gone</p><form><input value="typed"><button>Go</button></form>
            <noscript>No JS</noscript><iframe src="https://evil.example"></iframe></body>`,
            BASE
        );
        expect(page.blocks.map((block) => block.text)).toEqual(["Safe"]);
        expect(JSON.stringify(page)).not.toMatch(/<|alert|onerror|Secret|typed|Icon|Gone/);
    });

    it("prefers the page's main content", () => {
        const page = readHtml(
            `<body><nav><a href="/">Home</a></nav><main><p>Story</p></main><footer>Foot</footer></body>`,
            BASE
        );
        expect(page.blocks.map((block) => block.text)).toEqual(["Story"]);
    });

    it("reads loose text in a container as a paragraph", () => {
        const page = readHtml(`<body><div>Loose <em>text</em><p>Para</p>Tail</div></body>`, BASE);
        expect(page.blocks.map((block) => block.text)).toEqual(["Loose text", "Para", "Tail"]);
    });

    it("keeps a block's link, absolute, when the block is that link", () => {
        const page = readHtml(
            `<body><li><a href="../about">About us</a></li><p>Read <a href="/x">this</a> now</p>
            <p><a href="javascript:alert(1)">Bad</a></p><div><a href="//cdn.example.com/a">Cdn</a></div></body>`,
            BASE
        );
        expect(page.blocks).toEqual([
            { tag: "li", text: "About us", href: "https://example.com/about" },
            { tag: "p", text: "Read this now", href: null },
            { tag: "p", text: "Bad", href: null },
            { tag: "p", text: "Cdn", href: "https://cdn.example.com/a" }
        ]);
    });

    it("is bounded however long the page is", () => {
        const page = readHtml(`<body>${"<p>x</p>".repeat(BLOCKS_MAX + 50)}</body>`, BASE);
        expect(page.blocks).toHaveLength(BLOCKS_MAX);
    });

    it("finds nothing in an empty page", () => {
        expect(readHtml("", BASE).blocks).toEqual([]);
    });
});

describe("safeHref", () => {
    it("allows http and https only", () => {
        expect(safeHref("/a", BASE)).toBe("https://example.com/a");
        expect(safeHref("mailto:a@example.com", BASE)).toBeNull();
        expect(safeHref("data:text/html,x", BASE)).toBeNull();
        expect(safeHref(" JavaScript:alert(1)", BASE)).toBeNull();
        expect(safeHref(null, BASE)).toBeNull();
    });
});
