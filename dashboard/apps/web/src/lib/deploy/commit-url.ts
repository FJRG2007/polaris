/**
 * Where a commit can be read on the web, from the repository a service deploys
 * from.
 *
 * Only forges whose URL shape is known are placed. Guessing a path for an
 * arbitrary git host would produce a link that 404s, and a deployment showing a
 * commit with no link is better than one showing a link to nothing - the short
 * SHA identifies the build either way.
 */

/**
 * Clone URL forms a service can be configured with: https, `git@host:owner/repo`
 * and `ssh://git@host/owner/repo`, each with an optional `.git` and trailing
 * slash.
 *
 * Credentials and an explicit port both have to be consumed rather than ignored.
 * A private repo cloned with a token (`https://x-access-token:TOKEN@github.com/o/r`)
 * would otherwise read its host out of the credentials and never get a link, and
 * `ssh://git@github.com:22/o/r` would read the port as the first path segment and
 * build exactly the 404 this module exists to avoid. The host class excludes `@`
 * so nothing can smuggle a different host in through the userinfo - the host is
 * where the clone actually goes, which is the one this commit lives on.
 */
const CLONE_URL = /^(?:(?:https?|ssh):\/\/)?(?:[^/@]+@)?([^/@:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/i;

export function commitUrl(repoUrl: string, sha: string): string | null {
    if (!sha) return null;
    const match = repoUrl.match(CLONE_URL);
    const host = match?.[1]?.toLowerCase();
    const path = match?.[2];
    if (!host || !path) return null;
    if (host === "github.com" || host === "bitbucket.org") return `https://${host}/${path}/commit/${sha}`;
    if (host === "gitlab.com") return `https://${host}/${path}/-/commit/${sha}`;
    return null;
}
