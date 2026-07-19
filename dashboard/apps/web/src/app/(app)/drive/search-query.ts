/**
 * Smart-search query parser for the Files browser. Supports a small,
 * dork/Shodan-style syntax on top of plain fuzzy matching:
 *   - glob wildcards:      *-presentacion.pptx   report-2024-??.pdf
 *   - explicit regex:      /invoice_\d+/          (optionally with flags)
 *   - extension filter:    ext:pptx,pdf,key
 *   - path search:         documentos/doc.pdf     c:/reports/*.xlsx
 *   - free text:           anything else -> fuzzy match (fuse.js)
 * Tokens combine with AND (all must match); free-text words are fuzzy-matched
 * against whatever survives the structured filters. When any token contains a
 * path separator the whole query switches to "path mode": globs/regex/fuzzy are
 * matched against the item's full relative path instead of just its name, so a
 * user can search "documentos/doc.pdf". Pure and side-effect free.
 */

export interface ParsedQuery {
    /** Allowed extensions (dot-less, lowercase). Empty means no extension filter. */
    extensions: string[];
    /** Glob/regex patterns the target must ALL match. */
    patterns: RegExp[];
    /** Remaining free text for a fuzzy pass. */
    fuzzy: string;
    /** True when the query targets full paths (a token contains a separator). */
    pathMode: boolean;
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

/** Whether a token references a path (has a forward or back slash). */
function isPathToken(token: string): boolean {
    return token.includes("/") || token.includes("\\");
}

/**
 * Normalize a path or a path-shaped query token to a common form: back-slashes to
 * forward, a leading drive letter (c:) and leading slashes stripped, lowercased.
 * Lets a Windows-style query ("c:/Docs/x.pdf") match a connection-relative path.
 */
export function normalizePathTarget(value: string): string {
    return value
        .replace(/\\/g, "/")
        .replace(/^[a-zA-Z]:/, "")
        .replace(/^\/+/, "")
        .toLowerCase();
}

/** Parse a raw search string into structured filters plus a fuzzy remainder. */
export function parseSearch(query: string): ParsedQuery {
    const trimmed = query.trim();
    const result: ParsedQuery = { extensions: [], patterns: [], fuzzy: "", pathMode: false };
    if (!trimmed) return result;

    // A query that is entirely /pattern/flags is treated as one regex.
    const explicit = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
    if (explicit) {
        result.pathMode = /[\\/]/.test(explicit[1]!);
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
        } else if (isPathToken(token)) {
            result.pathMode = true;
            const normalized = normalizePathTarget(token);
            if (token.includes("*") || token.includes("?")) result.patterns.push(globToRegExp(normalized));
            else fuzzyWords.push(normalized);
        } else if (token.includes("*") || token.includes("?")) {
            result.patterns.push(globToRegExp(token));
        } else {
            fuzzyWords.push(token);
        }
    }
    result.fuzzy = fuzzyWords.join(" ");
    return result;
}

/** Whether a name/path passes the structured (non-fuzzy) part of a parsed query. */
export function matchesStructured(name: string, path: string, parsed: ParsedQuery): boolean {
    if (parsed.extensions.length > 0) {
        const dot = name.lastIndexOf(".");
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
        if (!parsed.extensions.includes(ext)) return false;
    }
    // In path mode, glob/regex patterns test the full (normalized) path.
    const target = parsed.pathMode ? normalizePathTarget(path) : name;
    for (const pattern of parsed.patterns) {
        if (!pattern.test(target)) return false;
    }
    return true;
}
