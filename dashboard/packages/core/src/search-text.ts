/**
 * When a search should stop guessing.
 *
 * Every list in Polaris that people search is searched fuzzily, and that is the
 * right default: the way somebody looks for a task is by half remembering it, so
 * "useragent" has to find "user agent" and a transposed letter has to find the
 * thing anyway.
 *
 * It is the wrong behaviour for the other half of what gets typed into a search
 * box. Pasting a URL, a path, an address or an identifier is not half
 * remembering anything - it is naming one exact thing - and a fuzzy matcher
 * handed a forty-character string scores almost every row as a partial match, so
 * the answer is a list of everything with the one row that actually contains it
 * somewhere in the middle. That is the report this exists to fix: a GitHub URL
 * pasted into the task search returned tasks that do not contain it.
 *
 * So the query decides. Anything that reads like a value is matched literally;
 * anything that reads like words a person is recalling stays fuzzy. Nothing here
 * knows what is being searched - it is the query and some strings - so every
 * list can use the same rule and none of them has to write its own.
 */

/** Past this many characters with no space in it, a query is a value somebody
 *  pasted rather than a word somebody is recalling. */
const LITERAL_LENGTH = 20;

/** What says "this is an address, a path or an identifier" wherever it appears. */
const LITERAL_MARKS = ["://", "/", "\\", "@", "#"] as const;

/**
 * Whether a query names one exact thing.
 *
 * Three ways to be one, in the order somebody would expect:
 *
 * - It is quoted. Quoting is how every search box in the world is told to stop
 *   being clever, and it is the escape hatch when the rules below get it wrong.
 * - It carries a mark that only appears in a value: a scheme, a path separator,
 *   an "@", a fragment.
 * - It is one long unbroken run of characters, which prose is not.
 */
export function isLiteralQuery(query: string): boolean {
    const trimmed = query.trim();
    if (trimmed.length < 3) return false;
    if (quoted(trimmed)) return true;
    if (LITERAL_MARKS.some((mark) => trimmed.includes(mark))) return true;
    return !/\s/.test(trimmed) && trimmed.length >= LITERAL_LENGTH;
}

function quoted(value: string): boolean {
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"');
}

/** The query with its quotes taken off, which is what is actually looked for. */
export function literalNeedle(query: string): string {
    const trimmed = query.trim();
    return quoted(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

/**
 * Whether any of a row's fields contains the query.
 *
 * Case-insensitive and nothing else: a literal search is literal, which is the
 * whole point of it. A row with no field carrying the value does not match,
 * however much of it happens to appear somewhere.
 */
export function matchesLiterally(
    query: string,
    fields: readonly (string | null | undefined)[]
): boolean {
    const needle = literalNeedle(query).toLowerCase();
    if (!needle) return false;
    return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}
