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

/** The headers an artifact's bytes go out with. */
export function artifactHeaders(input: {
    mediaType: string;
    name: string;
    size: number;
    download: boolean;
    immutable: boolean;
}): Record<string, string> {
    const kind = artifactKind(input.mediaType);
    const inline = !input.download && kind !== "binary";
    const ascii = input.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return {
        "content-type": input.mediaType,
        "content-length": String(input.size),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(input.name)}`,
        "content-security-policy": ARTIFACT_CSP,
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "cache-control": input.immutable ? "private, max-age=31536000, immutable" : "private, no-cache"
    };
}
