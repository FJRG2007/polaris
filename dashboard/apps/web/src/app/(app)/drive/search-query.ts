/**
 * Smart-search query parser for the Files browser. Supports a small,
 * dork/Shodan-style syntax on top of plain fuzzy matching:
 *   - glob wildcards:      *-presentacion.pptx   report-2024-??.pdf
 *   - explicit regex:      /invoice_\d+/          (optionally with flags)
 *   - extension filter:    ext:pptx,pdf,key
 *   - path search:         documentos/doc.pdf     c:/users/me/report.pdf
 *   - free text:           anything else -> fuzzy match (fuse.js)
 * A query that contains a path separator is treated as a path search: it matches
 * against an item's full relative path rather than its name (and, in the UI, is
 * run recursively so nested matches surface). Otherwise tokens combine with AND;
 * free-text words are fuzzy-matched against whatever survives the structured
 * filters. Pure and side-effect free.
 */

export interface ParsedQuery {
    /** Allowed extensions (dot-less, lowercase). Empty means no extension filter. */
    extensions: string[];
    /** Glob/regex patterns the name must ALL match. */
    patterns: RegExp[];
    /** Remaining free text for a fuzzy pass. */
    fuzzy: string;
    /**
     * Set when the query is a path (contains a separator): a predicate over an
     * item's full relative path. When present, name-based structured/fuzzy matching
     * is bypassed and this is the sole criterion.
     */
    pathMatcher?: (relPath: string) => boolean;
    /** Set when an explicit /regex/ failed to compile. */
    error?: string;
}

/**
 * Normalize a path for comparison: lowercase, backslashes to forward slashes, a
 * leading drive letter ("c:") dropped, and leading/duplicate slashes collapsed.
 * So "C:\\Users\\Me\\a.pdf" and "/users/me/a.pdf" both reduce to "users/me/a.pdf".
 */
function normalizePath(value: string): string {
    return value
        .toLowerCase()
        .replace(/\\/g, "/")
        .replace(/^[a-z]:/, "")
        .replace(/^\/+/, "")
        .replace(/\/+/g, "/");
}

/** A predicate matching an item's relative path against a path query, or null. */
function buildPathMatcher(raw: string): ((relPath: string) => boolean) | null {
    const needle = normalizePath(raw.trim());
    if (!needle) return null;
    if (/[*?]/.test(needle)) {
        const source = needle
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");
        const regex = new RegExp(source, "i");
        return (relPath) => regex.test(normalizePath(relPath));
    }
    return (relPath) => normalizePath(relPath).includes(needle);
}

/** Convert a glob (with * and ?) into an anchored, case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
}

/** Parse a raw search string into structured filters plus a fuzzy remainder. */
export function parseSearch(query: string): ParsedQuery {
    const trimmed = query.trim();
    const result: ParsedQuery = { extensions: [], patterns: [], fuzzy: "" };
    if (!trimmed) return result;

    // A query that is entirely /pattern/flags is treated as one regex.
    const explicit = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
    if (explicit) {
        try {
            result.patterns.push(new RegExp(explicit[1]!, (explicit[2] ?? "").replace(/g/g, "") || "i"));
        } catch {
            result.error = "Invalid regular expression";
        }
        return result;
    }

    // A query with a path separator searches by full relative path, not by name.
    if (/[\\/]/.test(trimmed)) {
        const pathMatcher = buildPathMatcher(trimmed);
        if (pathMatcher) result.pathMatcher = pathMatcher;
        return result;
    }

    const fuzzyWords: string[] = [];
    for (const token of trimmed.split(/\s+/)) {
        const lower = token.toLowerCase();
        if (lower.startsWith("ext:")) {
            for (const raw of lower.slice(4).split(",")) {
                const ext = raw.trim().replace(/^\./, "");
                if (ext) result.extensions.push(ext);
            }
        } else if (token.includes("*") || token.includes("?")) {
            result.patterns.push(globToRegExp(token));
        } else {
            fuzzyWords.push(token);
        }
    }
    result.fuzzy = fuzzyWords.join(" ");
    return result;
}

/** Whether a filename passes the structured (non-fuzzy) part of a parsed query. */
export function matchesStructured(name: string, parsed: ParsedQuery): boolean {
    if (parsed.extensions.length > 0) {
        const dot = name.lastIndexOf(".");
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
        if (!parsed.extensions.includes(ext)) return false;
    }
    for (const pattern of parsed.patterns) {
        if (!pattern.test(name)) return false;
    }
    return true;
}
