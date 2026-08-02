/**
 * Reading what the user typed into the repository field.
 *
 * The field takes one line of anything: a browser URL copied off a repo page, an
 * SSH remote pasted from a clone command, the `owner/repo` shorthand, or a git
 * URL somewhere other than GitHub. Deciding which it is has to happen in the
 * browser (to know whether to search at all) and on the server (to know which
 * repository to look up), so the parsing lives here once rather than twice.
 *
 * Pure string work, no network - what a reference points at is only answered by
 * asking GitHub.
 */

export interface RepoReference {
    owner: string;
    repo: string;
}

/** Owners and repository names GitHub itself allows: letters, digits, and a few
 *  separators. Anything else is a search phrase, not a reference. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Repository paths under github.com that are not repositories. */
const RESERVED_OWNERS = new Set(["settings", "orgs", "features", "about", "pricing", "login", "sponsors"]);

function cleanSegments(owner: string, repo: string): RepoReference | null {
    const name = repo.replace(/\.git$/i, "");
    if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
    if (name === "." || name === ".." || RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    return { owner, repo: name };
}

/**
 * The GitHub repository the input names, or null if it names none. Accepts
 * `https://github.com/owner/repo`, the same with a trailing `.git`, a deep link
 * into a branch or file, `git@github.com:owner/repo.git`, a bare
 * `github.com/owner/repo`, and the `owner/repo` shorthand.
 */
export function parseGithubRepo(input: string): RepoReference | null {
    const value = input.trim();
    if (!value) return null;

    const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)\/*$/i.exec(value);
    if (ssh) return cleanSegments(ssh[1] ?? "", ssh[2] ?? "");

    // A deep link (…/tree/main/src) still identifies the repo, so only the first
    // two path segments are read and the rest is dropped.
    const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(value);
    if (url) return cleanSegments(url[1] ?? "", url[2] ?? "");

    const shorthand = /^([^/\s]+)\/([^/\s]+?)\/*$/.exec(value);
    if (shorthand) return cleanSegments(shorthand[1] ?? "", shorthand[2] ?? "");

    return null;
}

/** A commit, as GitHub identifies one. */
export interface CommitReference extends RepoReference {
    /** Lowercased; GitHub renders seven characters and stores forty. */
    sha: string;
}

/**
 * The commit the input names, or null.
 *
 * Accepts the URL from the browser bar, the plural `/commits/` path the API
 * hands back, and the `owner/repo@sha` shorthand people write in chat. The
 * repository half goes through `parseGithubRepo`, so everything that is not a
 * repository there - a settings page, a reserved owner - is not a commit here
 * either.
 */
export function parseGithubCommit(input: string): CommitReference | null {
    const value = input.trim();
    if (!value) return null;

    const url = /^(.*github\.com\/[^/?#]+\/[^/?#]+)\/commits?\/([0-9a-f]{7,40})\b/i.exec(value);
    if (url) {
        const repo = parseGithubRepo(url[1] as string);
        return repo ? { ...repo, sha: (url[2] as string).toLowerCase() } : null;
    }

    const shorthand = /^([^\s@]+)@([0-9a-f]{7,40})$/i.exec(value);
    if (shorthand) {
        const repo = parseGithubRepo(shorthand[1] as string);
        return repo ? { ...repo, sha: (shorthand[2] as string).toLowerCase() } : null;
    }
    return null;
}

/**
 * A clonable git URL that is not on GitHub (GitLab, Bitbucket, a self-hosted
 * remote), normalized, or null. This is the escape hatch behind the picker: the
 * repository search only knows GitHub, but a deploy only needs a URL.
 */
export function externalGitUrl(input: string): string | null {
    const value = input.trim();
    if (!/^https?:\/\//i.test(value)) return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") return null;
    // A bare host is not a repository; there has to be a path to clone.
    if (parsed.pathname.replace(/\/+$/, "") === "") return null;
    // Credentials in the URL would be stored in plain text on the application.
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
}
