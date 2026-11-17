/**
 * The pure half of a session's artifacts: what the deliverables folder is,
 * how its listing is read, what changed since the last capture, how a file is
 * drawn, and the headers its bytes are served with. No I/O here, so every rule
 * is asserted in a test and the browser can share the drawing rules.
 */

/** The folder an agent leaves its deliverables in, relative to the checkout. */
export const DELIVERABLES_DIR = ".polaris/deliverables";

/** The most files one session's folder is captured with; past this it is cut. */
export const ARTIFACT_MAX_FILES = 200;
/** The largest file captured. A bigger one is left where it is. */
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
/** Every version of every artifact of one session, together. */
export const SESSION_ARTIFACT_MAX_BYTES = 250 * 1024 * 1024;
/** Versions kept per artifact; the oldest go first. */
export const ARTIFACT_MAX_VERSIONS = 30;

/** How a file is drawn. */
export type ArtifactKind = "markdown" | "html" | "image" | "text" | "binary";

/** One line of the container's listing. */
export interface ListedArtifact {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A path inside the deliverables folder, or null. Relative, no step out, no
 * hidden part, no control character, so it is safe to name to the container
 * and to show.
 */
export function deliverablePath(path: string): string | null {
    if (!path || path.length > 512 || path.startsWith("/")) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(path)) return null;
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) return null;
    return path;
}

/**
 * The listing the capture script writes (`size<TAB>sha256<TAB>path` a line),
 * read back. A line that does not parse is skipped rather than trusted: the
 * folder is the agent's to fill.
 */
export function parseListing(text: string): { files: ListedArtifact[]; truncated: boolean } {
    const files: ListedArtifact[] = [];
    let truncated = false;
    for (const line of text.split("\n")) {
        if (!line) continue;
        const [sizeText, sha256, ...rest] = line.split("\t");
        const path = deliverablePath(rest.join("\t"));
        const size = Number(sizeText);
        if (!path || !SHA256.test(sha256 ?? "") || !Number.isSafeInteger(size) || size < 0) continue;
        if (files.length >= ARTIFACT_MAX_FILES) {
            truncated = true;
            break;
        }
        files.push({ path, size, sha256: sha256 as string });
    }
    return { files, truncated };
}

/** What the capture does with a listing, against what is already stored. */
export interface CapturePlan {
    /** New files, and files whose bytes changed: each gets a version. */
    readonly capture: ListedArtifact[];
    /** Files larger than a capture takes, left out. */
    readonly tooLarge: ListedArtifact[];
    /** Stored artifacts no longer in the folder. */
    readonly removed: string[];
    /** Stored artifacts that came back unchanged after being removed. */
    readonly restored: string[];
}

export function capturePlan(
    listed: readonly ListedArtifact[],
    stored: ReadonlyArray<{ path: string; sha256: string; removed: boolean }>
): CapturePlan {
    const known = new Map(stored.map((row) => [row.path, row]));
    const here = new Set(listed.map((file) => file.path));
    const capture: ListedArtifact[] = [];
    const tooLarge: ListedArtifact[] = [];
    const restored: string[] = [];
    for (const file of listed) {
        const row = known.get(file.path);
        if (row && row.sha256 === file.sha256) {
            if (row.removed) restored.push(file.path);
            continue;
        }
        if (file.size > ARTIFACT_MAX_BYTES) tooLarge.push(file);
        else capture.push(file);
    }
    const removed = stored.filter((row) => !row.removed && !here.has(row.path)).map((row) => row.path);
    return { capture, tooLarge, removed, restored };
}

const EXTENSION_TYPES: Record<string, string> = {
    md: "text/markdown; charset=utf-8",
    markdown: "text/markdown; charset=utf-8",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    json: "application/json; charset=utf-8",
    pdf: "application/pdf",
    csv: "text/csv; charset=utf-8",
    txt: "text/plain; charset=utf-8"
};

function extensionOf(path: string): string {
    const name = path.split("/").at(-1) ?? path;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * The type a file is stored and served as: by its extension where that is
 * known, else plain text when its first stretch has no NUL, else bytes.
 */
export function artifactMediaType(path: string, head: Uint8Array): string {
    const known = EXTENSION_TYPES[extensionOf(path)];
    if (known) return known;
    return head.subarray(0, 8000).includes(0) ? "application/octet-stream" : "text/plain; charset=utf-8";
}

/** How a stored type is drawn. */
export function artifactKind(mediaType: string): ArtifactKind {
    const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (base === "text/markdown") return "markdown";
    if (base === "text/html") return "html";
    if (base.startsWith("image/")) return "image";
    if (base.startsWith("text/") || base === "application/json") return "text";
    return "binary";
}

/**
 * The content policy an artifact's bytes are served under. `sandbox` without
 * `allow-same-origin` gives the document an opaque origin even when somebody
 * opens the address on its own, so a page an agent wrote never runs as the
 * signed-in reader; it may draw from the web, never call home with what it reads.
 */
export const ARTIFACT_CSP = [
    "sandbox allow-scripts allow-popups",
    "default-src 'none'",
    "script-src 'unsafe-inline' https:",
    "style-src 'unsafe-inline' https:",
    "img-src data: blob: https:",
    "font-src data: https:",
    "media-src data: blob: https:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
].join("; ");

/**
 * The policy a page and the files beside it are served under when they are
 * read by path (`artifactFramePath`): the same one, with `'self'` added where a
 * page loads its own pictures, styles and scripts, so a relative reference to
 * a file next to it draws on an install served over plain HTTP too. Still no
 * `connect-src`: the page reads nothing back.
 */
export const ARTIFACT_FRAME_CSP = [
    "sandbox allow-scripts allow-popups",
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self' data: blob: https:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
].join("; ");

/**
 * The deliverable a path-based address names (its segments as the route
 * received them, already decoded), or null for anything that is not a plain
 * path inside the deliverables folder: a step out, a hidden part, an empty
 * segment, a control character.
 */
export function artifactFramePath(segments: readonly string[]): string | null {
    if (segments.length === 0 || segments.length > 32) return null;
    if (segments.some((segment) => segment.includes("/") || segment.includes("\\"))) return null;
    return deliverablePath(segments.join("/"));
}

/**
 * Whether a page's reader may load `path` beside it. Somebody who may read the
 * whole session may load any of its files; somebody the page alone was shared
 * with (a grant on it, or its link) only the files in the page's own folder and
 * below it - what the page was delivered with, never the session's work
 * outside the deliverables folder. A page at the top of the folder reaches the
 * whole folder, which is what it was delivered beside.
 */
export function frameReaches(anchorPath: string, path: string, wholeSession: boolean): boolean {
    if (wholeSession || path === anchorPath) return true;
    const slash = anchorPath.lastIndexOf("/");
    if (slash < 0) return true;
    return path.startsWith(anchorPath.slice(0, slash + 1));
}

/** The address of a page read by path: `base` then each segment encoded. */
export function framedUrl(base: string, path: string, version: number): string {
    return `${base}/${path.split("/").map(encodeURIComponent).join("/")}?v=${version}`;
}

/** The headers an artifact's bytes go out with. */
export function artifactHeaders(input: {
    mediaType: string;
    name: string;
    size: number;
    download: boolean;
    immutable: boolean;
    /** Read by path from inside a page's frame, whose origin is opaque. */
    framed?: boolean;
}): Record<string, string> {
    const kind = artifactKind(input.mediaType);
    const inline = !input.download && kind !== "binary";
    const ascii = input.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return {
        "content-type": input.mediaType,
        "content-length": String(input.size),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(input.name)}`,
        "content-security-policy": input.framed ? ARTIFACT_FRAME_CSP : ARTIFACT_CSP,
        "x-content-type-options": "nosniff",
        // A frame with an opaque origin is never same-origin, so a file it loads
        // by path is let through; the address itself carries the right to it.
        "cross-origin-resource-policy": input.framed ? "cross-origin" : "same-origin",
        "referrer-policy": "no-referrer",
        "cache-control": input.immutable ? "private, max-age=31536000, immutable" : "private, no-cache"
    };
}
