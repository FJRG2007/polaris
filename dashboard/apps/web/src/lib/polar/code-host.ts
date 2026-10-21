/**
 * Which code repository an address names, for Polar's repository tools
 * (`code-host-tools.ts`).
 *
 * A repository page in the browser shows a listing, not the files, so a model
 * reading that page can only guess what is inside. These functions turn the
 * address into a repository the hosts' APIs can be asked about. Pure string
 * work, shared by the chat route, the screen note and the panel's step rows.
 *
 * Supported: github.com (and raw.githubusercontent.com), and gitlab.com with
 * its nested groups. A self-hosted GitLab is not read: telling it apart from
 * any other site needs a request to that site first.
 */

export type CodeHost = "github" | "gitlab";

export interface RepoAddress {
    host: CodeHost;
    /** GitHub: the owner. GitLab: the whole namespace, groups joined by `/`. */
    owner: string;
    name: string;
    /** `tree` or `blob` when the address points inside the repository. */
    kind: "tree" | "blob" | null;
    /**
     * What follows `tree/` or `blob/`: a ref and then a path. A ref can hold a
     * slash (`release/2.x`), so where one ends and the other begins is only
     * known by asking the host (`refCandidates`).
     */
    rest: string[];
}

/** First path segments on github.com that are not an owner. */
const GITHUB_RESERVED = new Set([
    "about",
    "apps",
    "codespaces",
    "collections",
    "contact",
    "customer-stories",
    "enterprise",
    "events",
    "explore",
    "features",
    "issues",
    "login",
    "marketplace",
    "new",
    "notifications",
    "orgs",
    "organizations",
    "pricing",
    "pulls",
    "search",
    "security",
    "settings",
    "signup",
    "site",
    "sponsors",
    "topics",
    "trending",
    "users"
]);

/** First path segments on gitlab.com that are not a group or a user. */
const GITLAB_RESERVED = new Set([
    "admin",
    "api",
    "dashboard",
    "explore",
    "groups",
    "help",
    "projects",
    "search",
    "users"
]);

/** Owner and repository names both hosts allow. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function segmentsOf(url: URL): string[] | null {
    try {
        return url.pathname
            .split("/")
            .filter(Boolean)
            .map((part) => decodeURIComponent(part));
    } catch {
        return null;
    }
}

function valid(name: string): boolean {
    return SEGMENT.test(name) && name !== "." && name !== "..";
}

function insideKind(part: string | undefined): "tree" | "blob" | null {
    return part === "tree" || part === "blob" ? part : null;
}

function github(segments: string[]): RepoAddress | null {
    const [owner, raw, marker, ...rest] = segments;
    if (!owner || !raw || GITHUB_RESERVED.has(owner.toLowerCase())) return null;
    const name = raw.replace(/\.git$/i, "");
    if (!valid(owner) || !valid(name)) return null;
    const kind = insideKind(marker);
    return {
        host: "github",
        owner,
        name,
        kind: kind && rest.length ? kind : null,
        rest: kind ? rest : []
    };
}

function githubRaw(segments: string[]): RepoAddress | null {
    const [owner, name, ...rest] = segments;
    if (!owner || !name || !valid(owner) || !valid(name) || rest.length < 2) return null;
    return { host: "github", owner, name, kind: "blob", rest };
}

function gitlab(segments: string[]): RepoAddress | null {
    const dash = segments.indexOf("-");
    const project = dash >= 0 ? segments.slice(0, dash) : segments;
    if (project.length < 2 || GITLAB_RESERVED.has(project[0]!.toLowerCase())) return null;
    const last = project.length - 1;
    project[last] = project[last]!.replace(/\.git$/i, "");
    if (!project.every(valid)) return null;
    const after = dash >= 0 ? segments.slice(dash + 1) : [];
    const kind = insideKind(after[0]);
    const rest = kind ? after.slice(1) : [];
    return {
        host: "gitlab",
        owner: project.slice(0, last).join("/"),
        name: project[last]!,
        kind: kind && rest.length ? kind : null,
        rest
    };
}

/** The repository an address names, or null for anything else. Pure. */
export function parseRepoAddress(address: string): RepoAddress | null {
    let url: URL;
    try {
        url = new URL(
            /^[a-z][a-z0-9+.-]*:\/\//i.test(address.trim())
                ? address.trim()
                : `https://${address.trim()}`
        );
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const segments = segmentsOf(url);
    if (!segments) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "github.com") return github(segments);
    if (host === "raw.githubusercontent.com") return githubRaw(segments);
    if (host === "gitlab.com") return gitlab(segments);
    return null;
}

/**
 * What a tool was handed as the repository: any address `parseRepoAddress`
 * reads, or GitHub's `owner/repo` shorthand. Pure.
 */
export function parseRepoInput(input: string): RepoAddress | null {
    const value = input.trim();
    // A GitHub owner holds no dot, so `example.org/x` is not read as one.
    const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
    if (short) {
        const [, owner, name] = short;
        return valid(owner!) && valid(name!.replace(/\.git$/i, ""))
            ? {
                  host: "github",
                  owner: owner!,
                  name: name!.replace(/\.git$/i, ""),
                  kind: null,
                  rest: []
              }
            : null;
    }
    return parseRepoAddress(value);
}

/** `owner/name` for GitHub, the full project path for GitLab. Pure. */
export function repoLabel(repo: Pick<RepoAddress, "owner" | "name">): string {
    return `${repo.owner}/${repo.name}`;
}

/** The repository's own page, for links in an answer. Pure. */
export function repoWebUrl(repo: Pick<RepoAddress, "host" | "owner" | "name">): string {
    return `https://${repo.host === "github" ? "github.com" : "gitlab.com"}/${repoLabel(repo)}`;
}

/** Most slashes a ref is assumed to hold when an address is split. */
const REF_DEPTH = 4;

/**
 * The ways `rest` can split into a ref and a path, shortest ref first: most
 * refs hold no slash, so the first guess is nearly always the one. Pure.
 */
export function refCandidates(rest: readonly string[]): { ref: string; path: string }[] {
    const out: { ref: string; path: string }[] = [];
    for (let take = 1; take <= Math.min(rest.length, REF_DEPTH); take += 1) {
        out.push({ ref: rest.slice(0, take).join("/"), path: rest.slice(take).join("/") });
    }
    return out;
}

/** Repository addresses written in a text, in order, each once. Pure. */
export function reposInText(text: string): RepoAddress[] {
    const found = new Map<string, RepoAddress>();
    const pattern =
        /\b(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|raw\.githubusercontent\.com)\/[^\s<>()"'`]+/gi;
    for (const match of text.matchAll(pattern)) {
        const repo = parseRepoAddress(match[0].replace(/[.,;:!?]+$/, ""));
        if (repo) found.set(`${repo.host}:${repoLabel(repo).toLowerCase()}`, repo);
    }
    return [...found.values()];
}

/** The slice of a chat message this reads. */
interface MessageLike {
    role: string;
    parts: readonly { type: string; text?: unknown }[];
}

/**
 * Whether this turn is about a repository: the page the person shares is one,
 * or they wrote a repository's address in the conversation. Pure.
 */
export function aboutRepository(
    siteUrl: string | undefined,
    messages: readonly MessageLike[]
): boolean {
    if (siteUrl && parseRepoAddress(siteUrl)) return true;
    return messages.some(
        (message) =>
            message.role === "user" &&
            message.parts.some(
                (part) =>
                    part.type === "text" &&
                    typeof part.text === "string" &&
                    reposInText(part.text).length > 0
            )
    );
}

/** Polar's repository tools, by name. */
export const REPO_TOOLS = {
    overview: "repo_overview",
    list: "repo_list_files",
    read: "repo_read_file",
    search: "repo_search",
    commits: "repo_commits"
} as const;

export type RepoStepKind = keyof typeof REPO_TOOLS;

const KIND_OF: Readonly<Record<string, RepoStepKind>> = Object.fromEntries(
    Object.entries(REPO_TOOLS).map(([kind, name]) => [name, kind as RepoStepKind])
);

/**
 * What a repository step row says: which repository, and the path or query it
 * was about. Null for any other tool. Pure, for the panel.
 */
export function repoStepOf(
    name: string,
    input: unknown
): { kind: RepoStepKind; repo: string; detail: string } | null {
    const kind = KIND_OF[name];
    if (!kind) return null;
    const record = (input && typeof input === "object" ? input : {}) as {
        repository?: unknown;
        path?: unknown;
        query?: unknown;
    };
    const written = typeof record.repository === "string" ? record.repository : "";
    const parsed = parseRepoInput(written);
    const repo = parsed ? repoLabel(parsed) : written;
    const fromAddress = parsed?.kind ? (refCandidates(parsed.rest)[0]?.path ?? "") : "";
    const path = typeof record.path === "string" && record.path ? record.path : fromAddress;
    const detail =
        kind === "search" ? (typeof record.query === "string" ? record.query : "") : path || repo;
    return { kind, repo, detail };
}
