/**
 * A small model that cannot call tools properly sometimes writes the call as
 * text instead: `<polar_remember>{"text": "..."}</polar_remember>`, often with
 * no closing tag. Nothing ran, and the markup is not meant for anybody to
 * read, so it is taken out of what the answer shows, copies and reads aloud.
 *
 * Only Polar's own tool names (`polar_*`) are matched, so an answer that talks
 * about HTML or XML keeps every tag it means. While the answer streams, a tag
 * still being written at the end is held back rather than flashing on screen.
 *
 * Pure and safe in the browser.
 */

/** An opening tag, an optional JSON object on the same call, an optional close. */
const CALL = /<(polar_[a-z0-9_]+)>[ \t]*(?:\r?\n)?[ \t]*(\{[^\n]*\})?[ \t]*(?:<\/\1>)?/g;

/** A closing tag left on its own. */
const STRAY_CLOSE = /<\/polar_[a-z0-9_]+>/g;

/** A tag cut off at the end of what has arrived so far. */
const PARTIAL = /<\/?(?:p(?:o(?:l(?:a(?:r(?:_[a-z0-9_]*)?)?)?)?)?)?$/;

/** The answer's words without tool calls written out as text. */
export function withoutPseudoToolCalls(text: string): string {
    if (!text.includes("<")) return text;
    const cleaned = text.replace(CALL, "").replace(STRAY_CLOSE, "").replace(PARTIAL, "");
    return cleaned === text ? text : cleaned.replace(/\n{3,}/g, "\n\n").trim();
}
