/**
 * The one search every list in Polaris runs.
 *
 * Each screen used to hand its rows to Fuse with a threshold of 0.3 to 0.4 and
 * `ignoreLocation` on, often over a description or a message body. That is a
 * matcher told to accept a third of the letters being wrong anywhere in a
 * paragraph, and it answered accordingly: a word that appears in no task at all
 * came back with a screenful of tasks that share a few letters with it. The
 * report this fixes is exactly that.
 *
 * What the products people compare Polaris with do instead (Linear's find in
 * view, GitHub's and VS Code's quick open, Notion's search) is the shape here:
 *
 * - The query is words, and a row matches only if it carries every one of them,
 *   each somewhere in one of its fields. Case, accents and runs of whitespace do
 *   not count, so "cancion" finds "Canción".
 * - Ranked by where they matched: the title being exactly the query, then the
 *   title starting with it, then every word starting a word of the title, then
 *   every word inside the title, then the rest by how heavily weighted the
 *   fields that carried them are. Within a rank, the order the screen already
 *   had - its recency, its rank - stands.
 * - A typo is forgiven only when nothing matched as typed, only against the
 *   words of the title, and only for words long enough to carry one. A
 *   description is never fuzzy-matched: in a paragraph, almost any word is one
 *   letter away from something.
 * - Quoting a query, or pasting something that reads like a value (an address,
 *   a path, an identifier), is asking for exactly that, so it is matched as one
 *   piece and never guessed at.
 *
 * A query that matches nothing therefore answers nothing, and the screen says so.
 *
 * Why the typo pass is not Fuse, which every list used before: Fuse's Bitap
 * scores how close the word comes to any stretch of the text, and counts two
 * letters turned around as two mistakes. So a threshold loose enough to forgive
 * "factrua" for "factura" also lets it find "actua" inside "Actualizar" (drop
 * the f, drop the r), and one strict enough not to stops forgiving the swap. An
 * edit distance between whole words, where a swap is one mistake, draws that
 * line where a person would.
 */

/** Past this many characters with no space in it, a query is a value somebody
 *  pasted rather than a word somebody is recalling. */
const LITERAL_LENGTH = 20;

/** What says "this is an address, a path or an identifier" wherever it appears. */
const LITERAL_MARKS = ["://", "/", "\\", "@", "#"] as const;

/** The shortest word a typo is forgiven in. Below it, one letter off is a
 *  different word ("cat", "car", "cap") rather than a misspelling. */
const MIN_FUZZY_WORD = 4;

/** From this length a word may carry two mistakes rather than one. */
const TWO_EDIT_WORD = 8;

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
 * Text as a search compares it: accents and other combining marks dropped,
 * lowercase, underscores read as the spaces they stand for, and every run of
 * whitespace one space.
 */
export function normalizeSearchText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[\s_]+/g, " ")
        .trim();
}

/** What one field of a row holds: a string, nothing, or several strings (tags,
 *  the people on a message). */
export type SearchFieldText = string | null | undefined | readonly (string | null | undefined)[];

/**
 * One place in a row that a search reads.
 *
 * The first field of a list is the row's title: it decides the top ranks and is
 * the only one a typo is forgiven in, so it should be the short name somebody
 * remembers - never a description.
 */
export interface SearchField<T> {
    readonly text: (item: T) => SearchFieldText;
    /** How much a word found here counts against one found elsewhere. 1 when
     *  left out. Only orders matches; it never decides whether a row matches. */
    readonly weight?: number;
}

export interface SearchOptions<T> {
    /** At most this many rows, best first. */
    readonly limit?: number;
    /** How two rows that matched equally well are ordered. Left out, they keep
     *  the order they were handed in, which is the screen's own. */
    readonly tieBreak?: (left: T, right: T) => number;
}

/** A query taken apart into what is looked for. */
interface ParsedQuery {
    /** The words, every one of which a row has to carry. */
    readonly words: readonly string[];
    /** The whole query, normalized, for the exact-title rank. */
    readonly whole: string;
    /** Whether a typo may be forgiven at all. */
    readonly fuzzy: boolean;
}

function parseQuery(query: string): ParsedQuery {
    const literal = isLiteralQuery(query);
    const whole = normalizeSearchText(literalNeedle(query));
    if (!whole) return { words: [], whole, fuzzy: false };
    // A literal query is one piece; anything else is its words, each once.
    const words = literal ? [whole] : [...new Set(whole.split(" "))];
    return { words, whole, fuzzy: !literal };
}

/** A row as a search reads it. */
interface Normalized {
    /** Each field, normalized: one list of strings per field. */
    readonly fields: readonly (readonly string[])[];
    /**
     * What a misspelt word is compared with: every word of the title, and every
     * two neighbouring ones run together, so "useragent" still finds
     * "user agent".
     */
    readonly titleWords: readonly string[];
    /** How many words the title has, so a guess that accounts for all of a
     *  short title ranks above one that accounts for a corner of a long one. */
    readonly titleLength: number;
}

function normalizeRow<T>(item: T, fields: readonly SearchField<T>[]): Normalized {
    const normalized = fields.map((field) => {
        const value = field.text(item);
        const values = typeof value === "string" ? [value] : (value ?? []);
        const out: string[] = [];
        for (const one of values) {
            if (!one) continue;
            const normalized = normalizeSearchText(one);
            if (normalized) out.push(normalized);
        }
        return out;
    });
    const titleWords: string[] = [];
    let titleLength = 0;
    for (const title of normalized[0] ?? []) {
        const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        titleLength += words.length;
        words.forEach((word, at) => {
            titleWords.push(word);
            if (at > 0) titleWords.push(words[at - 1] + word);
        });
    }
    return { fields: normalized, titleWords, titleLength };
}

/**
 * The normalized text of every row, kept for as long as the row and the field
 * list live.
 *
 * Normalizing a description is the expensive part of a keystroke over a few
 * thousand tasks, and the rows are the same rows from one keystroke to the next.
 * Weak on both keys, so neither a replaced list nor a replaced row is kept alive
 * by its own cache. A row that is not an object (a plain string) is normalized
 * each time, which costs what the string costs.
 */
const normalizedRows = new WeakMap<object, WeakMap<object, Normalized>>();

function normalizedFor<T>(item: T, fields: readonly SearchField<T>[]): Normalized {
    if (typeof item !== "object" || item === null) return normalizeRow(item, fields);
    let byItem = normalizedRows.get(fields);
    if (!byItem) {
        byItem = new WeakMap();
        normalizedRows.set(fields, byItem);
    }
    let row = byItem.get(item);
    if (!row) {
        row = normalizeRow(item, fields);
        byItem.set(item, row);
    }
    return row;
}

/** Whether `word` starts a word of `text`: at its start, or after anything that
 *  is not a letter or a digit. */
function startsWord(text: string, word: string): boolean {
    let at = text.indexOf(word);
    while (at !== -1) {
        if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]!)) return true;
        at = text.indexOf(word, at + 1);
    }
    return false;
}

const containedIn = (values: readonly string[], word: string): boolean =>
    values.some((value) => value.includes(word));

/**
 * How well a row matched as typed, lower being better, or null when it did not.
 *
 * 0 the title is the query, 1 the title starts with it, 2 every word starts a
 * word of the title, 3 every word is inside the title, 4 the words are spread
 * across the fields - with the fraction below 1 ranking those by the weight of
 * the fields that carried them.
 */
function exactRank<T>(
    row: Normalized,
    parsed: ParsedQuery,
    fields: readonly SearchField<T>[]
): number | null {
    const title = row.fields[0] ?? [];
    if (title.includes(parsed.whole)) return 0;
    if (title.some((value) => value.startsWith(parsed.whole))) return 1;
    if (parsed.words.every((word) => title.some((value) => startsWord(value, word)))) return 2;
    if (parsed.words.every((word) => containedIn(title, word))) return 3;
    let carried = 0;
    let possible = 0;
    for (const word of parsed.words) {
        let best = 0;
        let heaviest = 0;
        fields.forEach((field, at) => {
            const weight = field.weight ?? 1;
            heaviest = Math.max(heaviest, weight);
            if (weight > best && containedIn(row.fields[at] ?? [], word)) best = weight;
        });
        if (best === 0) return null;
        carried += best;
        possible += heaviest;
    }
    // Every word in the heaviest field still ranks below every word in the title.
    return 4 + (1 - carried / possible) * 0.999;
}

/** How many mistakes a word of this length may carry and still be the word. */
function allowedEdits(word: string): number {
    if (word.length < MIN_FUZZY_WORD) return 0;
    return word.length >= TWO_EDIT_WORD ? 2 : 1;
}

/**
 * How many mistakes turn `typed` into `word` - a letter added, dropped, changed,
 * or two neighbours swapped, each counting one - or `limit + 1` once it is
 * plainly more than `limit`.
 */
function editDistance(typed: string, word: string, limit: number): number {
    if (Math.abs(typed.length - word.length) > limit) return limit + 1;
    let before: number[] = [];
    let previous = Array.from({ length: word.length + 1 }, (_, at) => at);
    for (let i = 1; i <= typed.length; i++) {
        const current = [i];
        let lowest = i;
        for (let j = 1; j <= word.length; j++) {
            const cost = typed[i - 1] === word[j - 1] ? 0 : 1;
            let best = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
            if (i > 1 && j > 1 && typed[i - 1] === word[j - 2] && typed[i - 2] === word[j - 1]) {
                best = Math.min(best, before[j - 2]! + 1);
            }
            current.push(best);
            lowest = Math.min(lowest, best);
        }
        if (lowest > limit) return limit + 1;
        before = previous;
        previous = current;
    }
    return previous[word.length]!;
}

/**
 * How far the words a row lacks are from words of its title, or null when one
 * of them is not near enough to any. The mistakes count whole; the fraction
 * after them is how much of the title the query leaves unaccounted for.
 *
 * Every word still has to be in the row: as typed in any field, or within its
 * allowed mistakes of a word of the title.
 */
function fuzzyDistance(row: Normalized, parsed: ParsedQuery): number | null {
    let total = 0;
    for (const word of parsed.words) {
        if (row.fields.some((values) => containedIn(values, word))) continue;
        const limit = allowedEdits(word);
        if (limit === 0) return null;
        let best = limit + 1;
        for (const candidate of row.titleWords) {
            best = Math.min(best, editDistance(word, candidate, limit));
            if (best === 0) break;
        }
        if (best > limit) return null;
        total += best;
    }
    const covered = Math.min(parsed.words.length, row.titleLength);
    return total + (row.titleLength === 0 ? 0 : (1 - covered / row.titleLength) * 0.999);
}

/**
 * The rows matching what somebody typed, best first.
 *
 * An empty query is every row, in the order given. A query no row carries is no
 * rows at all.
 */
export function searchItems<T>(
    items: readonly T[],
    query: string,
    fields: readonly SearchField<T>[],
    options: SearchOptions<T> = {}
): T[] {
    const { limit, tieBreak } = options;
    const parsed = parseQuery(query);
    if (parsed.words.length === 0) return limit === undefined ? [...items] : items.slice(0, limit);

    const rows = items.map((item) => normalizedFor(item, fields));
    const ranked: { at: number; rank: number }[] = [];
    rows.forEach((row, at) => {
        const rank = exactRank(row, parsed, fields);
        if (rank !== null) ranked.push({ at, rank });
    });
    if (ranked.length === 0 && parsed.fuzzy) {
        rows.forEach((row, at) => {
            const off = fuzzyDistance(row, parsed);
            if (off !== null) ranked.push({ at, rank: 5 + off });
        });
    }
    ranked.sort(
        (left, right) =>
            left.rank - right.rank ||
            (tieBreak?.(items[left.at]!, items[right.at]!) ?? 0) ||
            left.at - right.at
    );
    const found = ranked.map((entry) => items[entry.at]!);
    return limit === undefined ? found : found.slice(0, limit);
}
