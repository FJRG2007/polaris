/**
 * Where the Polaris desktop app is downloaded from.
 *
 * The repository this deployment updates from (`POLARIS_REPO`, which the update
 * checker already reads) publishes the app as GitHub releases tagged
 * `desktop-v*` - see `.github/workflows/desktop.yml`. The same repository also
 * releases the dashboard, so its "latest release" is not necessarily the app;
 * the link is the releases page searched for the desktop tags, newest first.
 */

/** An "owner/name" GitHub accepts. Anything else - a typo in the environment -
 *  gets no link rather than a link to a page that is not there. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function desktopReleasesUrl(repo: string): string | null {
    const trimmed = repo.trim();
    if (!REPO.test(trimmed)) return null;
    return `https://github.com/${trimmed}/releases?q=desktop-v&expanded=true`;
}
