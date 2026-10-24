/**
 * The docs search index: built per locale when the site is generated, split so
 * the first open downloads only the titles and headings, and searched in the
 * browser with the same matcher every list in the dashboard runs - every word
 * has to be there, a word may be the start or the middle of one, and a typo in
 * a title is forgiven when nothing matched as typed.
 */

import { searchItems, type SearchField } from "@polaris/core/search-text";

/** One place search can land: a guide, a section of one, or an API operation. */
export interface SearchRecord {
    /** What the row says: the page or the heading. */
    readonly title: string;
    /** The page it belongs to, which is also the group it is listed under. */
    readonly page: string;
    /** A path under the site root, without the base path (`en/docs/drive/#sharing`). */
    readonly href: string;
    /** The section's text; empty until its chunk has loaded. */
    readonly text: string;
}

/** What the first open downloads: every record without its text, and where the texts are. */
export interface SearchManifest {
    readonly records: readonly Omit<SearchRecord, "text">[];
    /** File names beside the manifest; chunk `n` holds the texts of records `starts[n]` onwards. */
    readonly chunks: readonly string[];
    readonly starts: readonly number[];
}

/** About this many characters of text per chunk. */
export const CHUNK_CHARS = 48_000;

/** Records split into a manifest and text chunks of roughly `size` characters each. */
export function chunkIndex(
    records: readonly SearchRecord[],
    size = CHUNK_CHARS
): { manifest: SearchManifest; chunks: string[][] } {
    const chunks: string[][] = [];
    const starts: number[] = [];
    let current: string[] = [];
    let length = 0;
    records.forEach((record, at) => {
        if (current.length && length + record.text.length > size) {
            chunks.push(current);
            current = [];
            length = 0;
        }
        if (!current.length) starts.push(at);
        current.push(record.text);
        length += record.text.length;
    });
    if (current.length) chunks.push(current);
    return {
        manifest: {
            records: records.map(({ title, page, href }) => ({ title, page, href })),
            chunks: chunks.map((_, at) => `${at}.json`),
            starts
        },
        chunks
    };
}

/** The records with the texts of whichever chunks have arrived filled in. */
export function joinIndex(
    manifest: SearchManifest,
    loaded: ReadonlyMap<number, readonly string[]>
): SearchRecord[] {
    const texts: string[] = new Array(manifest.records.length).fill("");
    for (const [chunk, values] of loaded) {
        const start = manifest.starts[chunk] ?? 0;
        values.forEach((text, at) => {
            if (start + at < texts.length) texts[start + at] = text;
        });
    }
    return manifest.records.map((record, at) => ({ ...record, text: texts[at]! }));
}

const FIELDS: readonly SearchField<SearchRecord>[] = [
    { text: (record) => record.title, weight: 4 },
    { text: (record) => record.page, weight: 2 },
    { text: (record) => record.text, weight: 1 }
];

/** A group of results under its page, best page first. */
export interface SearchGroupResult {
    readonly page: string;
    readonly records: readonly SearchRecord[];
}

/**
 * The best matches for a query, grouped under their page. A page's group sits
 * where its best match ranked, so grouping never buries the top answer.
 */
export function searchIndex(
    records: readonly SearchRecord[],
    query: string,
    limit = 30
): SearchGroupResult[] {
    if (!query.trim()) return [];
    const groups = new Map<string, SearchRecord[]>();
    for (const record of searchItems(records, query, FIELDS, { limit })) {
        const group = groups.get(record.page);
        if (group) group.push(record);
        else groups.set(record.page, [record]);
    }
    return [...groups].map(([page, found]) => ({ page, records: found }));
}

/** The part of a section's text around its first match, so a row can show why it matched. */
export function snippet(text: string, terms: readonly string[], length = 140): string {
    if (text.length <= length) return text;
    const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    let at = -1;
    for (const term of terms) {
        const found = folded.indexOf(term);
        if (found !== -1 && (at === -1 || found < at)) at = found;
    }
    // Folding only drops combining marks, which NFD put after their letter, so
    // an offset into the folded text is close enough to cut the original at.
    const start = Math.max(0, Math.min(at - 40, text.length - length));
    const cut = text.slice(start, start + length).trim();
    return `${start > 0 ? "... " : ""}${cut}${start + length < text.length ? " ..." : ""}`;
}

/** How many recent searches are kept per locale. */
export const MAX_RECENT = 8;

/** One search somebody opened a result of. */
export interface RecentSearch {
    readonly title: string;
    readonly page: string;
    readonly href: string;
}

/** The list with `entry` at its head, without an older copy of it, at most `MAX_RECENT` long. */
export function rememberRecent(list: readonly RecentSearch[], entry: RecentSearch): RecentSearch[] {
    return [entry, ...list.filter((one) => one.href !== entry.href)].slice(0, MAX_RECENT);
}

/** A stored list read back, keeping only entries of the right shape. */
export function parseRecent(raw: string | null): RecentSearch[] {
    if (!raw) return [];
    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return [];
        return value
            .filter(
                (one): one is RecentSearch =>
                    !!one &&
                    typeof one === "object" &&
                    typeof (one as RecentSearch).title === "string" &&
                    typeof (one as RecentSearch).page === "string" &&
                    typeof (one as RecentSearch).href === "string" &&
                    // Only paths on this site: a stored entry must never send somebody elsewhere.
                    /^[a-z]{2}\/[^\s]*$/.test((one as RecentSearch).href)
            )
            .slice(0, MAX_RECENT);
    } catch {
        return [];
    }
}
