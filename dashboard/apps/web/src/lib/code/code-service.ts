/**
 * Pull requests and issues, from the repositories somebody has linked.
 *
 * Read live from GitHub rather than mirrored into Polaris. A mirror of somebody
 * else's issue tracker is a sync problem with no winning end state - it is stale
 * the moment somebody comments in the other window, and reconciling that is a
 * whole product. This is the same choice Drive already makes about files: the
 * remote is the truth, Polaris is the window.
 *
 * Every call is made as the person asking, with a token from an account they
 * linked themselves. There is no instance-credential fallback anywhere in this
 * module, and that is deliberate: a fallback is how one operator's token ends up
 * showing their private repositories to every account on the box.
 *
 * The lists come from GitHub's search, which is what makes "assigned to me
 * across everything" one request rather than one per repository. Its rate limit
 * is lower and it is eventually consistent by a few seconds - both acceptable
 * for a screen somebody reads, and neither acceptable for something a decision
 * is automated on, which is why nothing here is used by the agents.
 */

import { githubTokenForUser } from "@/lib/github-access";

const API = "https://api.github.com";

/** What a list can be narrowed to. Each is a GitHub search qualifier, named for
 *  what somebody is actually looking for rather than for the qualifier. */
export const CODE_SCOPES = ["assigned", "created", "review", "mentioned", "all"] as const;

export type CodeScope = (typeof CODE_SCOPES)[number];

export const CODE_KINDS = ["pr", "issue"] as const;

export type CodeKind = (typeof CODE_KINDS)[number];

export const CODE_STATES = ["open", "closed", "all"] as const;

export type CodeState = (typeof CODE_STATES)[number];

/** One row of the list. */
export interface CodeItem {
    readonly id: number;
    readonly number: number;
    readonly kind: CodeKind;
    readonly title: string;
    readonly repo: string;
    readonly authorLogin: string;
    readonly authorAvatar: string | null;
    readonly state: "open" | "closed" | "merged" | "draft";
    readonly comments: number;
    readonly labels: readonly { name: string; color: string }[];
    readonly updatedAt: string;
    readonly url: string;
}

/** One pull request or issue, opened. */
export interface CodeDetail extends CodeItem {
    readonly body: string;
    readonly assignees: readonly string[];
    /** Only on a pull request. */
    readonly branches: { base: string; head: string } | null;
    readonly mergeable: boolean | null;
    readonly merged: boolean;
    readonly createdAt: string;
}

export interface CodeComment {
    readonly id: number;
    readonly authorLogin: string;
    readonly authorAvatar: string | null;
    readonly body: string;
    readonly createdAt: string;
    /** A review comment carries a verdict; an ordinary one does not. */
    readonly review: "approved" | "changes_requested" | "commented" | null;
}

/** Why a call could not be made, in words a screen can show as they are. */
export class CodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CodeError";
    }
}

/** How many rows one page holds. GitHub's search caps at 100; this is a screen. */
const PAGE = 30;

/**
 * The list, for one person.
 *
 * `scope` becomes the qualifier that decides whose work this is. "all" is
 * everything in the repositories they can reach, which GitHub answers by
 * involvement rather than by enumerating repositories - the honest version of
 * "everything" for a token whose reach is not knowable up front.
 */
export async function listWork(
    userId: string,
    options: { kind: CodeKind; scope: CodeScope; state: CodeState; query?: string }
): Promise<CodeItem[]> {
    const token = await githubTokenForUser(userId);
    if (!token) {
        throw new CodeError("Link a GitHub account first, under My account > Connected accounts.");
    }

    const parts = [options.kind === "pr" ? "is:pr" : "is:issue"];
    if (options.state !== "all") parts.push(`is:${options.state}`);
    parts.push(qualifierFor(options.scope));
    if (options.query?.trim()) parts.push(options.query.trim());

    const url = `${API}/search/issues?q=${encodeURIComponent(parts.filter(Boolean).join(" "))}&sort=updated&order=desc&per_page=${PAGE}`;
    const payload = await read<{ items?: RawItem[] }>(url, token);
    return (payload.items ?? []).map(toItem);
}

/** One item, with everything the detail screen draws except its comments. */
export async function readWork(
    userId: string,
    owner: string,
    repo: string,
    number: number
): Promise<CodeDetail> {
    const token = await githubTokenForUser(userId, owner);
    if (!token) throw new CodeError("Link a GitHub account that reaches that repository.");

    const issue = await read<RawItem>(
        `${API}/repos/${slug(owner)}/${slug(repo)}/issues/${number}`,
        token
    );
    const item = toItem({ ...issue, repository_url: `${API}/repos/${owner}/${repo}` });

    if (item.kind !== "pr") {
        return {
            ...item,
            body: issue.body ?? "",
            assignees: (issue.assignees ?? []).map((person) => person.login),
            branches: null,
            mergeable: null,
            merged: false,
            createdAt: issue.created_at
        };
    }

    // A pull request is an issue with more on it, and the extra half only comes
    // back from the pulls endpoint.
    const pull = await read<RawPull>(
        `${API}/repos/${slug(owner)}/${slug(repo)}/pulls/${number}`,
        token
    );
    return {
        ...item,
        state: pull.merged ? "merged" : pull.draft ? "draft" : item.state,
        body: pull.body ?? issue.body ?? "",
        assignees: (issue.assignees ?? []).map((person) => person.login),
        branches: { base: pull.base.ref, head: pull.head.ref },
        mergeable: pull.mergeable ?? null,
        merged: Boolean(pull.merged),
        createdAt: issue.created_at
    };
}

/**
 * The conversation, in one list.
 *
 * Reviews and ordinary comments are two endpoints and one thread to a reader, so
 * they are merged and sorted by time. A review with no body is dropped: GitHub
 * writes one for every line comment, and a timeline of empty entries is worse
 * than a timeline missing them.
 */
export async function readConversation(
    userId: string,
    owner: string,
    repo: string,
    number: number,
    kind: CodeKind
): Promise<CodeComment[]> {
    const token = await githubTokenForUser(userId, owner);
    if (!token) throw new CodeError("Link a GitHub account that reaches that repository.");

    const base = `${API}/repos/${slug(owner)}/${slug(repo)}`;
    const [comments, reviews] = await Promise.all([
        read<RawComment[]>(`${base}/issues/${number}/comments?per_page=100`, token),
        kind === "pr"
            ? read<RawReview[]>(`${base}/pulls/${number}/reviews?per_page=100`, token).catch(
                  () => [] as RawReview[]
              )
            : Promise.resolve([] as RawReview[])
    ]);

    const merged: CodeComment[] = [
        ...comments.map((comment) => ({
            id: comment.id,
            authorLogin: comment.user?.login ?? "someone",
            authorAvatar: comment.user?.avatar_url ?? null,
            body: comment.body ?? "",
            createdAt: comment.created_at,
            review: null
        })),
        ...reviews
            .filter((review) => (review.body ?? "").trim().length > 0)
            .map((review) => ({
                id: review.id,
                authorLogin: review.user?.login ?? "someone",
                authorAvatar: review.user?.avatar_url ?? null,
                body: review.body ?? "",
                createdAt: review.submitted_at ?? "",
                review: verdictOf(review.state)
            }))
    ];

    return merged.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Say something on it. The same endpoint for both kinds - GitHub treats a pull
 *  request's conversation as the issue's. */
export async function comment(
    userId: string,
    owner: string,
    repo: string,
    number: number,
    body: string
): Promise<void> {
    const token = await githubTokenForUser(userId, owner);
    if (!token) throw new CodeError("Link a GitHub account that reaches that repository.");

    await write(`${API}/repos/${slug(owner)}/${slug(repo)}/issues/${number}/comments`, token, {
        method: "POST",
        body: JSON.stringify({ body })
    });
}

/** Close it, or open it again. */
export async function setState(
    userId: string,
    owner: string,
    repo: string,
    number: number,
    state: "open" | "closed"
): Promise<void> {
    const token = await githubTokenForUser(userId, owner);
    if (!token) throw new CodeError("Link a GitHub account that reaches that repository.");

    await write(`${API}/repos/${slug(owner)}/${slug(repo)}/issues/${number}`, token, {
        method: "PATCH",
        body: JSON.stringify({ state })
    });
}

/**
 * Merge a pull request.
 *
 * The one genuinely irreversible verb here, so it is its own function rather
 * than a flag on `setState`: a screen that could merge by passing a different
 * string to a general-purpose call is a screen one typo away from merging
 * something.
 */
export async function merge(
    userId: string,
    owner: string,
    repo: string,
    number: number,
    method: "merge" | "squash" | "rebase"
): Promise<void> {
    const token = await githubTokenForUser(userId, owner);
    if (!token) throw new CodeError("Link a GitHub account that reaches that repository.");

    await write(`${API}/repos/${slug(owner)}/${slug(repo)}/pulls/${number}/merge`, token, {
        method: "PUT",
        body: JSON.stringify({ merge_method: method })
    });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function qualifierFor(scope: CodeScope): string {
    if (scope === "assigned") return "assignee:@me";
    if (scope === "created") return "author:@me";
    if (scope === "review") return "review-requested:@me";
    if (scope === "mentioned") return "mentions:@me";
    // Everything they have had a hand in. GitHub has no "in every repository my
    // token reaches" qualifier, and enumerating repositories to build one would
    // be a request per repository for a list nobody would read to the end.
    return "involves:@me";
}

function slug(value: string): string {
    return encodeURIComponent(value);
}

function headers(token: string): HeadersInit {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "polaris"
    };
}

/**
 * A read, with GitHub's own refusals turned into sentences.
 *
 * The three that matter each mean something different to the reader and each
 * has a different next step, so they are distinguished rather than collapsed
 * into "that failed".
 */
async function read<T>(url: string, token: string): Promise<T> {
    const response = await fetch(url, { headers: headers(token), cache: "no-store" });
    if (!response.ok) throw refusal(response);
    return (await response.json()) as T;
}

async function write(url: string, token: string, init: RequestInit): Promise<void> {
    const response = await fetch(url, {
        ...init,
        headers: { ...headers(token), "content-type": "application/json" },
        cache: "no-store"
    });
    if (!response.ok) throw refusal(response);
}

function refusal(response: Response): CodeError {
    if (response.status === 401) {
        return new CodeError("GitHub no longer accepts that link. Reconnect the account.");
    }
    if (response.status === 403) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        if (remaining === "0") {
            return new CodeError("GitHub is rate limiting this account. Try again shortly.");
        }
        return new CodeError("That account cannot do that on this repository.");
    }
    if (response.status === 404) return new CodeError("That is not there, or not visible to you.");
    if (response.status === 405 || response.status === 409) {
        return new CodeError("GitHub refused the merge: it is not in a mergeable state.");
    }
    return new CodeError("GitHub could not answer that just now.");
}

function verdictOf(state: string | undefined): CodeComment["review"] {
    if (state === "APPROVED") return "approved";
    if (state === "CHANGES_REQUESTED") return "changes_requested";
    return "commented";
}

function toItem(raw: RawItem): CodeItem {
    const pull = Boolean(raw.pull_request);
    return {
        id: raw.id,
        number: raw.number,
        kind: pull ? "pr" : "issue",
        title: raw.title,
        // The API URL ends in /repos/<owner>/<name>, which is where the search
        // results carry the repository at all.
        repo: raw.repository_url.split("/repos/")[1] ?? "",
        authorLogin: raw.user?.login ?? "someone",
        authorAvatar: raw.user?.avatar_url ?? null,
        state: raw.pull_request?.merged_at
            ? "merged"
            : raw.draft
              ? "draft"
              : raw.state === "closed"
                ? "closed"
                : "open",
        comments: raw.comments ?? 0,
        labels: (raw.labels ?? []).map((label) => ({
            name: label.name,
            color: `#${label.color || "666666"}`
        })),
        updatedAt: raw.updated_at,
        url: raw.html_url
    };
}

interface RawUser {
    login: string;
    avatar_url?: string;
}

interface RawItem {
    id: number;
    number: number;
    title: string;
    body?: string | null;
    state: string;
    draft?: boolean;
    comments?: number;
    created_at: string;
    updated_at: string;
    html_url: string;
    repository_url: string;
    user?: RawUser;
    assignees?: RawUser[];
    labels?: { name: string; color: string }[];
    pull_request?: { merged_at?: string | null };
}

interface RawPull {
    body?: string | null;
    draft?: boolean;
    merged?: boolean;
    mergeable?: boolean | null;
    base: { ref: string };
    head: { ref: string };
}

interface RawComment {
    id: number;
    body?: string;
    created_at: string;
    user?: RawUser;
}

interface RawReview {
    id: number;
    body?: string;
    state?: string;
    submitted_at?: string;
    user?: RawUser;
}
