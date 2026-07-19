/**
 * Smart-search query parser for the Files browser. Supports a small,
 * dork/Shodan-style syntax on top of plain fuzzy matching:
 *   - glob wildcards:      *-presentacion.pptx   report-2024-??.pdf
 *   - explicit regex:      /invoice_\d+/          (optionally with flags)
 *   - extension filter:    ext:pptx,pdf,key
 *   - free text:           anything else -> fuzzy match (fuse.js)
 * Tokens combine with AND (all must match); free-text words are fuzzy-matched
 * against whatever survives the structured filters. Pure and side-effect free.
 */

export interface ParsedQuery {
    /** Allowed extensions (dot-less, lowercase). Empty means no extension filter. */
    extensions: string[];
    /** Glob/regex patterns the name must ALL match. */
    patterns: RegExp[];
    /** Remaining free text for a fuzzy pass. */
    fuzzy: string;
    /** Set when an explicit /regex/ failed to compile. */
    error?: string;
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
