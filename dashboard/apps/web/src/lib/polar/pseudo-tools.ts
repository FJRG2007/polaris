/**
 * A small model that cannot call tools properly sometimes writes the call as
 * text instead: `<polar_remember>{"text": "..."}</polar_remember>`, often with
 * no closing tag, and as often in an attribute's shape with no `>` at all -
 * `<polar_tools={"category": "home"}` or `<polar_tools {"category": "home"}/>`.
 * Nothing ran, and the markup is not meant for anybody to
 * read, so it is taken out of what the answer shows, copies and reads aloud.
 *
 * Only Polar's own tool names (`polar_*`) are matched, so an answer that talks
 * about HTML or XML keeps every tag it means. While the answer streams, a tag
 * still being written at the end is held back rather than flashing on screen.
 *
 * Pure and safe in the browser.
 */

/** An opening tag - closed by `>`, or left open before `=`, a space or the
 *  arguments - an optional JSON object on the same call, an optional end
 *  (`>`, `/>`) and an optional closing tag. */
const CALL =
    /<(polar_[a-z0-9_]+)(?:[ \t]*>|[ \t]*=|[ \t]+)?[ \t]*(?:\r?\n)?[ \t]*(\{[^\n]*\})?[ \t]*\/?>?[ \t]*(?:<\/\1>)?/g;

/** A call whose arguments are still arriving at the end of the text. */
const OPEN_CALL = /<polar_[a-z0-9_]+[ \t]*[=>]?[ \t]*\{[^\n]*$/;

/** A closing tag left on its own. */
const STRAY_CLOSE = /<\/polar_[a-z0-9_]+>/g;

/** A tag cut off at the end of what has arrived so far. */
const PARTIAL = /<\/?(?:p(?:o(?:l(?:a(?:r(?:_[a-z0-9_]*)?)?)?)?)?)?$/;

/** The answer's words without tool calls written out as text. */
export function withoutPseudoToolCalls(text: string): string {
    if (!text.includes("<")) return text;
    const cleaned = text
        .replace(OPEN_CALL, "")
        .replace(CALL, "")
        .replace(STRAY_CLOSE, "")
        .replace(PARTIAL, "");
    return cleaned === text ? text : cleaned.replace(/\n{3,}/g, "\n\n").trim();
}
