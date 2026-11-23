/**
 * How a picker names a repository the person reaches on GitHub that has no
 * agent row yet (`reachable-repos.ts`). Its own module so the browser can tell
 * one apart without loading the server side.
 */

export const GITHUB_REPO_PREFIX = "github:";

/** The `owner/repo` a picker reference names, or null for an agent row's id. */
export function githubRepoOf(id: string): string | null {
    return id.startsWith(GITHUB_REPO_PREFIX) ? id.slice(GITHUB_REPO_PREFIX.length) : null;
}
