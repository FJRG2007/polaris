/**
 * Path safety for storage drivers. Every browsable path a user supplies is
 * untrusted and could try to escape its connection's root ("../../etc/passwd").
 * These helpers normalize to a POSIX, root-relative form and reject traversal
 * before any path reaches a filesystem, an SFTP session, or the host daemon.
 */

/** Thrown when a supplied path escapes its root or is otherwise unsafe. */
export class UnsafePathError extends Error {
    public constructor(input: string) {
        super(`Unsafe path rejected: ${input}`);
        this.name = "UnsafePathError";
    }
}

/** True if the segment contains a C0 control character (code point below 0x20). */
function hasControlChar(segment: string): boolean {
    for (let i = 0; i < segment.length; i += 1) {
        if (segment.charCodeAt(i) < 0x20) return true;
    }
    return false;
}

/**
 * Normalize a user path to a clean, forward-slash, root-relative form with no
 * leading slash, no "." or ".." segments, and no duplicate separators. Throws
 * UnsafePathError if the path attempts to traverse above the root. The result is
 * always safe to join onto a connection root.
 */
export function normalizeRelPath(input: string): string {
    const segments = input.replace(/\\/g, "/").split("/");
    const out: string[] = [];
    for (const segment of segments) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            if (out.length === 0) throw new UnsafePathError(input);
            out.pop();
            continue;
        }
        // Reject NUL bytes and control characters that could confuse a backend.
        if (hasControlChar(segment)) throw new UnsafePathError(input);
        out.push(segment);
    }
    return out.join("/");
}

/** The parent directory of a normalized path ("a/b/c" -> "a/b"; root -> ""). */
export function parentPath(path: string): string {
    const normalized = normalizeRelPath(path);
    const idx = normalized.lastIndexOf("/");
    return idx < 0 ? "" : normalized.slice(0, idx);
}

/** The final segment of a normalized path ("a/b/c.txt" -> "c.txt"). */
export function baseName(path: string): string {
    const normalized = normalizeRelPath(path);
    const idx = normalized.lastIndexOf("/");
    return idx < 0 ? normalized : normalized.slice(idx + 1);
}

/** The lowercased extension without the dot ("Photo.JPG" -> "jpg"; none -> ""). */
export function extName(name: string): string {
    const base = baseName(name);
    const idx = base.lastIndexOf(".");
    return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

/** Join a normalized relative path onto a root, returning a safe POSIX join. */
export function joinUnderRoot(root: string, relPath: string): string {
    const rel = normalizeRelPath(relPath);
    const cleanRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    return rel === "" ? cleanRoot : `${cleanRoot}/${rel}`;
}
