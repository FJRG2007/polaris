/**
 * Where a commit can be read on the web, from the repository a service deploys
 * from.
 *
 * Only forges whose URL shape is known are placed. Guessing a path for an
 * arbitrary git host would produce a link that 404s, and a deployment showing a
 * commit with no link is better than one showing a link to nothing - the short
 * SHA identifies the build either way.
 */

/** Clone URL forms a service can be configured with: https, `git@host:owner/repo`,
 *  and `ssh://git@host/owner/repo`, each with an optional `.git` and trailing slash. */
const CLONE_URL = /^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/i;

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
