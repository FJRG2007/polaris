/**
 * The markup the Markdown renderer produces. A fenced block has to come out
 * highlighted, wrapped in the container its copy button anchors to, and with
 * anything it could not highlight escaped rather than left as markup - the
 * document is someone's file, not a template. Inline code has to carry the mark
 * the click-to-copy handler looks for, or copying silently does nothing.
 *
 * DOMPurify needs a DOM and there is none here, so it stands in as a pass-through
 * and what this pins is the renderer, not the sanitizer. The tags and attributes
 * the renderer emits (div, pre, code, span, class, title) are all on DOMPurify's
 * default allow list and none of them are in the FORBID lists it is called with.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
    default: { addHook: () => undefined, sanitize: (html: string) => html }
}));

const { renderMarkdown } = await import("../../../src/app/(app)/drive/viewer/markdown-render");

describe("renderMarkdown", () => {
    it("highlights a fenced block and wraps it for the copy button", async () => {
        const html = await renderMarkdown('```json\n{"name": "polaris"}\n```');
        expect(html).toContain('<div class="code-block">');
        expect(html).toContain('<code class="hljs">');
        expect(html).toContain("hljs-attr");
    });

    it("loads a grammar per fence, whichever tags a document mixes", async () => {
        const html = await renderMarkdown("```yml\nkey: value\n```\n\n```sql\nSELECT 1\n```");
        expect(html).toContain("hljs-attr");
        expect(html).toContain("hljs-keyword");
    });

    it("escapes a block it cannot highlight instead of emitting it", async () => {
        const html = await renderMarkdown("```\n<script>alert(1)</script>\n```");
        expect(html).toContain('<div class="code-block">');
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });

    it("marks inline code as copyable", async () => {
        const html = await renderMarkdown("Run `npm install` first.");
        expect(html).toContain('<code class="copy-inline" title="Copy">npm install</code>');
    });

    it("still renders ordinary prose", async () => {
        const html = await renderMarkdown("# Title\n\nSome **bold** text.");
        expect(html).toContain("<h1");
        expect(html).toContain("<strong>bold</strong>");
    });
});
