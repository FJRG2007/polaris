/**
 * The reading view's markup for a Word document, made safe to put on the page.
 *
 * mammoth converts a `.docx` faithfully and sanitizes nothing: a hyperlink's
 * target is copied from the package into `href` as it was written, so a
 * document can carry `javascript:` links that run on this origin, as whoever
 * clicked them, the moment somebody opens an attachment or a shared file and
 * presses one. Its output therefore goes through DOMPurify before it is ever
 * given to `dangerouslySetInnerHTML` - with its default URI rules, which keep
 * web, mail and in-document links and the `data:` pictures mammoth embeds.
 */

export async function sanitizeDocHtml(html: string): Promise<string> {
    const DOMPurify = (await import("dompurify")).default;
    return DOMPurify.sanitize(html, {
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
        FORBID_ATTR: ["style", "srcset"]
    });
}
