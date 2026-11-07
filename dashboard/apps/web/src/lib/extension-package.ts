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
