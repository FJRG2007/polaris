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

/**
 * The nth name to try for a file whose name is already taken, counting from 1:
 * "contract.pdf", then "contract (2).pdf", "contract (3).pdf", and so on.
 *
 * The number goes before the extension because that is where every file manager
 * puts it and because the extension is what decides how the file opens - moving
 * it, or appending after it, turns a PDF into something the recipient's machine
 * no longer recognizes. The split is on the LAST dot, so "backup.tar.gz" becomes
 * "backup.tar (2).gz"; a dotfile (".gitignore") has no extension to preserve and
 * takes the suffix at the end.
 *
 * A name is never rewritten to make room - only the arrival that would collide
 * is numbered - so the first upload of a name always keeps it verbatim.
 */
export function numberedName(name: string, attempt: number): string {
    const base = baseName(name);
    return attempt <= 1 ? base : withCopyNumber(base, attempt);
}

/**
 * A name with " (n)" before its extension: "report.pdf" and 1 give
 * "report (1).pdf". What "Keep both" names the arrival in Drive, the way every
 * desktop file manager does; the extension rules are `numberedName`'s.
 */
export function withCopyNumber(name: string, copy: number): string {
    const base = baseName(name);
    const dot = base.lastIndexOf(".");
    // idx <= 0 is a dotfile or a name with no extension: nothing to preserve.
    if (dot <= 0) return `${base} (${copy})`;
    return `${base.slice(0, dot)} (${copy})${base.slice(dot)}`;
}

/**
 * The form two Drive names are compared in. Drive treats "Report.pdf" and
 * "report.pdf" as the same name - most of the storages behind it (SMB, a NAS
 * share, a Windows or macOS disk) do - so a clash is decided on this key and
 * never on the raw strings. NFC first, so the same accented name typed on two
 * systems is not two names.
 */
export function driveNameKey(name: string): string {
    return name.normalize("NFC").toLowerCase();
}

/** Join a normalized relative path onto a root, returning a safe POSIX join. */
export function joinUnderRoot(root: string, relPath: string): string {
    const rel = normalizeRelPath(relPath);
    const posixRoot = root.replace(/\\/g, "/");
    // Trimming trailing slashes turns a filesystem root ("/") into "", which is
    // not a path any backend can open - an SFTP readdir of it fails with
    // "no such file". Keep the single slash for an absolute root.
    const trimmed = posixRoot.replace(/\/+$/, "");
    const cleanRoot = trimmed === "" && posixRoot.startsWith("/") ? "/" : trimmed;
    if (rel === "") return cleanRoot;
    return cleanRoot === "/" ? `/${rel}` : `${cleanRoot}/${rel}`;
}
