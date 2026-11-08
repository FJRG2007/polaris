/**
 * Serving the signed Firefox package from this deployment.
 *
 * Firefox opens its install prompt for a signed add-on only when the file comes
 * with `Content-Type: application/x-xpinstall` (Mozilla's "Self-distribution"
 * page). A GitHub release asset is not guaranteed to, so the package is relayed
 * from here with that type, and the downloads page links here rather than to
 * GitHub.
 */

/** The address the downloads page links to. */
export const FIREFOX_PACKAGE_ROUTE = "/api/polaris/extension/firefox";

/** What Firefox needs to see to offer the install. */
export const XPI_CONTENT_TYPE = "application/x-xpinstall";

/** A signed extension is a few hundred KiB; anything far past that is not ours. */
export const XPI_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Whether an asset address is one this route may fetch: a release download of
 * the repository it was asked about, on GitHub, over HTTPS. The address comes
 * from GitHub's API, and this keeps the relay from fetching anything else.
 */
export function isReleaseAsset(url: string, repo: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return false;
    return parsed.pathname
        .toLowerCase()
        .startsWith(`/${repo.trim().toLowerCase()}/releases/download/`);
}

const FETCH_TIMEOUT_MS = 30_000;

/** How long a failed download is remembered before it is tried again. */
export const PACKAGE_RETRY_MS = 2 * 60 * 1000;

/**
 * The newest package, held in memory. A release asset's address names its tag,
 * so the bytes behind one address never change: one slot holds them until the
 * release moves on, and a failure is held for `PACKAGE_RETRY_MS` so a stream of
 * requests does not become a stream of downloads from GitHub.
 */
let held: { url: string; body: ArrayBuffer | null; at: number } | null = null;
let pending: { url: string; body: Promise<ArrayBuffer | null> } | null = null;

async function download(url: string): Promise<ArrayBuffer | null> {
    const upstream = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    }).catch(() => null);
    if (!upstream?.ok) return null;
    // Refused before reading, when GitHub says up front that it is too big.
    if (Number(upstream.headers.get("content-length") ?? 0) > XPI_MAX_BYTES) {
        await upstream.body?.cancel().catch(() => undefined);
        return null;
    }
    const body = await upstream.arrayBuffer().catch(() => null);
    if (!body || body.byteLength === 0 || body.byteLength > XPI_MAX_BYTES) return null;
    return body;
}

/**
 * The bytes of the package at `url`, or null when it could not be fetched or is
 * not the size of an extension. Concurrent callers share one download.
 */
export async function packageBytes(url: string): Promise<ArrayBuffer | null> {
    if (held?.url === url && (held.body || Date.now() - held.at < PACKAGE_RETRY_MS)) {
        return held.body;
    }
    if (pending?.url === url) return pending.body;
    const body = download(url);
    pending = { url, body };
    try {
        const result = await body;
        held = { url, body: result, at: Date.now() };
        return result;
    } finally {
        if (pending?.body === body) pending = null;
    }
}

/** Forgets the held package. For tests. */
export function forgetPackage(): void {
    held = null;
    pending = null;
}
