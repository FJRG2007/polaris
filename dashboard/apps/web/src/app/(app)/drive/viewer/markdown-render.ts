/**
 * Markdown to sanitized HTML, kept apart from the viewer so the parsing rules
 * can be read (and tested) without the component around them.
 *
 * Two things the renderer adds beyond plain Markdown: fenced blocks are
 * highlighted and wrapped in a positioned container the copy button anchors to,
 * and inline code is marked as copyable. Both survive the sanitizer, which
 * allows `div`/`pre`/`code`/`span` and the `class`/`title` attributes.
 */

import { loadHighlighter } from "@/lib/code-highlight";

// Register the link-hardening hook once (module-scoped): every anchor opens in a
// new tab and cannot reach back into the opener.
let purifyHooked = false;

/** The opening tag of every fenced block, with the language it declares. */
const FENCE = /^ {0,3}(?:```+|~~~+)[ \t]*([\w+#.-]+)/gm;

/** Escapes code that could not be highlighted, since it goes in as markup. */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Render Markdown to sanitized HTML. Parsing (marked), sanitizing (DOMPurify)
 * and the grammars are dynamically imported so they never touch the main bundle,
 * and only the languages this document actually fences are loaded. The sanitizer
 * is deliberately strict: style/link/iframe/script/form/object and inline `style`
 * attributes are stripped, so a document can never inject CSS, exfiltrate, or run
 * script - only formatting, links, and images survive. All same-origin.
 */
export async function renderMarkdown(markdown: string): Promise<string> {
    const fenced = [...markdown.matchAll(FENCE)].map((match) => match[1] ?? "");
    const [{ Marked }, purifyModule, highlight] = await Promise.all([
        import("marked"),
        import("dompurify"),
        loadHighlighter(fenced)
    ]);
    const DOMPurify = purifyModule.default;
    if (!purifyHooked) {
        DOMPurify.addHook("afterSanitizeAttributes", (node) => {
            if (node.tagName === "A") {
                node.setAttribute("target", "_blank");
                node.setAttribute("rel", "noopener noreferrer nofollow");
            }
        });
        purifyHooked = true;
    }
    const marked = new Marked({
        gfm: true,
        renderer: {
            // The wrapper is what the copy button is anchored to: it does not
            // scroll with a long line the way the <pre> itself does.
            code(code, info, escaped) {
                const token = (info ?? "").trim().split(/\s+/)[0] ?? "";
                // `escaped` means the code arrives as markup already, so it can
                // neither be highlighted nor escaped a second time.
                const body = escaped ? code : (highlight(code, token) ?? escapeHtml(code));
                return `<div class="code-block"><pre><code class="hljs">${body}</code></pre></div>`;
            },
            // Marked has already escaped this one; it is marked up rather than
            // given a button so the surrounding line never reflows on hover.
            codespan(text) {
                return `<code class="copy-inline" title="Copy">${text}</code>`;
            }
        }
    });
    const dirty = marked.parse(markdown, { async: false }) as string;
    return DOMPurify.sanitize(dirty, {
        FORBID_TAGS: [
            "style",
            "link",
            "iframe",
            "script",
            "form",
            "input",
            "button",
            "meta",
            "base",
            "object",
            "embed"
        ],
        FORBID_ATTR: ["style", "srcset", "onerror", "onload"],
        ADD_ATTR: ["target", "rel"]
    });
}
