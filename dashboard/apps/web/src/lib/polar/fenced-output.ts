/**
 * A tool's answer as the panel shows it: a connector's output arrives fenced
 * (`<untrusted_connector_output connector="Stripe">...</...>`, see
 * `connectors/policy.ts`) so the model reads it as quoted content. The panel
 * names the connector the fence names and paints what is inside as the JSON it
 * usually is - one document, several (a connector's pieces joined by lines,
 * JSON lines), or one cut short by the `[cut at N characters]` mark. Pure,
 * safe on the client.
 */

const FENCED = /^\s*<untrusted_connector_output(?:\s+connector="([^"]*)")?[^>]*>\n?([\s\S]*?)\n?<\/untrusted_connector_output>\s*$/i;

/** The line a long answer is cut with (`connectors/policy.ts`, `tool-relevance.ts`). */
const CUT_MARK = /\n\[cut at \d+ characters\]\s*$/;

export interface ReadableOutput {
    /** The connector the fence names, or null when the text was not fenced. */
    connector: string | null;
    /** The text inside the fence, or the whole text; re-indented when it is JSON. */
    body: string;
    /** Set when `body` is JSON objects or arrays, the last maybe cut short. */
    json: boolean;
}

/**
 * The JSON objects and arrays `text` is made of, one after another, each
 * re-indented; null when it is anything else. With `cut` the last may end
 * unclosed, and is kept as it came.
 */
function jsonDocuments(text: string, cut: boolean): string[] | null {
    const documents: string[] = [];
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let at = 0; at < text.length; at++) {
        const char = text[at]!;
        if (depth === 0) {
            if (/\s/.test(char)) continue;
            if (char !== "{" && char !== "[") return null;
            start = at;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") {
            depth--;
            if (depth === 0) {
                try {
                    documents.push(JSON.stringify(JSON.parse(text.slice(start, at + 1)) as unknown, null, 2));
                } catch {
                    return null;
                }
            }
        }
    }
    if (depth > 0) {
        if (!cut) return null;
        documents.push(text.slice(start).trimEnd());
    }
    return documents.length > 0 ? documents : null;
}

/** A tool's text answer, unfenced and classified. Pure. */
export function readableOutput(text: string): ReadableOutput {
    const fenced = FENCED.exec(text);
    const connector = fenced ? (fenced[1] ?? "") : null;
    const body = fenced ? fenced[2]! : text;
    const mark = CUT_MARK.exec(body);
    const documents = jsonDocuments(mark ? body.slice(0, mark.index) : body, !!mark);
    if (!documents) return { connector, body, json: false };
    const painted = documents.join("\n");
    return { connector, body: mark ? `${painted}${mark[0].trimEnd()}` : painted, json: true };
}
