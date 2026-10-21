/**
 * Polar reading a GitHub or GitLab repository: its overview, a folder, a file,
 * a search over its paths (and its code where the host allows it), and its
 * recent commits. Read-only, through the hosts' REST APIs:
 *
 * - GitHub (docs.github.com/rest): `repos`, `contents`, `git/trees`,
 *   `commits`, `languages`, `readme`, and `search/code`, which GitHub only
 *   answers for a signed-in caller. A call is made with the person's own linked
 *   GitHub account when they have one (`github-access.ts`), so a private
 *   repository they can see reads too and the limit is GitHub's 5,000 an hour;
 *   without one it is anonymous, 60 an hour for this server's address.
 * - GitLab (docs.gitlab.com/api): gitlab.com's v4 API, anonymous, so public
 *   projects only. Polaris links no GitLab accounts.
 *
 * Both hosts are fixed addresses, never one the conversation chose, so these
 * calls need no guarded fetch. Whatever a repository holds is somebody else's
 * text: it reaches the model fenced the way a web page is (`fenceUntrusted`).
 *
 * Server-only.
 */

import { z } from "zod";
import { fenceUntrusted } from "@/lib/polar/web";
import { githubTokenForUser } from "@/lib/github-access";
import { githubAppGap, type GithubAppGap } from "@/lib/github-app-reach";
import { tool, type FlexibleSchema, type ToolSet } from "ai";
import { CONNECTIONS_HUB } from "@/lib/connections/hub-href";
import {
    REPO_TOOLS,
    parseRepoInput,
    refCandidates,
    repoLabel,
    repoWebUrl,
    type RepoAddress
} from "@/lib/polar/code-host";

const GITHUB_API = "https://api.github.com";
const GITLAB_API = "https://gitlab.com/api/v4";
/** How long one call to a host may take. */
const CALL_TIMEOUT_MS = 10_000;
/** Biggest JSON answer read from a host. */
const JSON_BYTES = 4 * 1024 * 1024;
/** Biggest file read: the most GitHub's contents API returns inline. */
export const FILE_BYTES = 1024 * 1024;
/** Most characters of a file handed to the model in one call. */
export const FILE_CHARS = 30_000;
/** Most characters of a README in an overview. */
const README_CHARS = 3_000;
/** Most entries one listing or search shows. */
const LIST_MOST = 200;
const SEARCH_MOST = 60;
/**
 * Biggest recursive tree read from GitHub. GitHub truncates a tree at 100,000
 * entries, and each entry in the JSON carries its sha and API url, so this is
 * room for a whole one.
 */
const TREE_BYTES = 32 * 1024 * 1024;
/** Most pages of a GitLab tree walked for a path search. */
const GITLAB_TREE_PAGES = 10;

/** One answer from a host, read and capped. */
interface HostReply {
    status: number;
    headers: Headers;
    /** Null when nothing could be read, or it was bigger than allowed. */
    bytes: Uint8Array | null;
    tooBig: boolean;
}

async function readBody(
    response: Response,
    most: number
): Promise<{ bytes: Uint8Array | null; tooBig: boolean }> {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > most) {
        await response.body?.cancel().catch(() => undefined);
        return { bytes: null, tooBig: true };
    }
    const reader = response.body?.getReader();
    if (!reader) return { bytes: new Uint8Array(), tooBig: false };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > most) {
            await reader.cancel().catch(() => undefined);
            return { bytes: null, tooBig: true };
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    return { bytes, tooBig: false };
}

async function call(
    url: string,
    headers: Record<string, string>,
    most = JSON_BYTES
): Promise<HostReply | null> {
    try {
        const response = await fetch(url, {
            headers,
            cache: "no-store",
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
        });
        const body = await readBody(response, most);
        return { status: response.status, headers: response.headers, ...body };
    } catch {
        return null;
    }
}

function json(reply: HostReply): unknown {
    if (!reply.bytes) return null;
    try {
        return JSON.parse(new TextDecoder().decode(reply.bytes));
    } catch {
        return null;
    }
}

/** Whether GitHub answered that the repository holds no commits yet. */
function githubEmpty(reply: HostReply): boolean {
    if (reply.status !== 404) return false;
    const parsed = z.object({ message: z.string() }).safeParse(json(reply));
    return parsed.success && /repository is empty/i.test(parsed.data.message);
}

/** A refusal worded for the model, which relays it to the person. `access` is
 *  the step that fixes it, which the chat draws as a button. */
class RepoFailure extends Error {
    constructor(
        message: string,
        readonly access?: GithubAppGap
    ) {
        super(message);
    }
}

/**
 * The sentence for a GitHub read refused over the App rather than over the
 * repository, or null when the App is not why. Worded for the model: it says
 * what to tell the person and that a button is already under the answer.
 */
export function gapSentence(gap: GithubAppGap, what: string): string {
    if (gap.kind === "no-account") {
        return `${what} was not found. If the repository is private, the person can link their GitHub account in Polaris under Connected accounts (${CONNECTIONS_HUB}) and ask again. A "Connect GitHub" button is shown under this answer.`;
    }
    if (gap.kind === "app-missing") {
        return `${what} could not be read: the Polaris GitHub app is not installed on ${gap.owner}, and the person's linked GitHub account only reaches repositories where it is installed - seeing the repository on github.com is not enough. Polaris has to be installed on ${gap.owner} first; if ${gap.owner} is an organization and the person is not one of its owners, GitHub sends the request to an owner to approve. An "Install Polaris on ${gap.owner}" button is shown under this answer: tell the person to use it and then press "Check again". Do not answer from the page or guess the contents instead.`;
    }
    return `${what} could not be read: the Polaris GitHub app is installed on ${gap.owner}, but only on selected repositories, and ${gap.repository} is not one of them. Whoever manages that installation has to add it. A "Choose repositories" button is shown under this answer: tell the person to use it and then press "Check again". Do not answer from the page or guess the contents instead.`;
}

/** The person a call is made for. */
interface Asker {
    userId: string;
}

/**
 * GitHub, as one person. The token is looked up once, on the first call, and
 * dropped if GitHub stops honouring it, so a stale link costs the private
 * repositories and not the public ones.
 */
class GithubClient {
    private token: string | null | undefined;
    private gap: Promise<GithubAppGap | null> | undefined;
    constructor(
        private readonly asker: Asker,
        private readonly owner: string,
        private readonly name: string
    ) {}

    /** Whether the App is why this repository is out of reach. Asked once, and
     *  only when the repository itself is: a missing path or ref inside one this
     *  account can read is not the App's doing. */
    private appGap(): Promise<GithubAppGap | null> {
        this.gap ??= this.repositoryReadable()
            .then((readable) =>
                readable ? null : githubAppGap(this.asker.userId, this.owner, this.name)
            )
            .catch(() => null);
        return this.gap;
    }

    private async repositoryReadable(): Promise<boolean> {
        const reply = await this.get(`/repos/${this.owner}/${this.name}`);
        return reply.status >= 200 && reply.status < 300;
    }

    async signedIn(): Promise<boolean> {
        if (this.token === undefined) {
            this.token = await githubTokenForUser(this.asker.userId, this.owner).catch(() => null);
        }
        return this.token !== null;
    }

    async get(
        path: string,
        accept = "application/vnd.github+json",
        most = JSON_BYTES
    ): Promise<HostReply> {
        const signed = await this.signedIn();
        const headers: Record<string, string> = {
            Accept: accept,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "polaris"
        };
        if (signed) headers.Authorization = `Bearer ${this.token}`;
        const reply = await call(`${GITHUB_API}${path}`, headers, most);
        if (!reply)
            throw new RepoFailure("GitHub could not be reached from this server right now.");
        if (reply.status === 401 && signed) {
            this.token = null;
            return this.get(path, accept, most);
        }
        return reply;
    }

    /** Throws the sentence for a reply that is not a success. */
    async check(reply: HostReply, what: string): Promise<void> {
        if (reply.status >= 200 && reply.status < 300) return;
        const signed = await this.signedIn();
        if (reply.status === 403 || reply.status === 429) {
            const remaining = reply.headers.get("x-ratelimit-remaining");
            const retry = reply.headers.get("retry-after");
            if (remaining === "0" || retry || reply.status === 429) {
                const reset = Number(reply.headers.get("x-ratelimit-reset") ?? "0");
                const when = reset
                    ? ` It resets at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC.`
                    : retry
                      ? ` Try again in ${retry} seconds.`
                      : "";
                throw new RepoFailure(
                    signed
                        ? `GitHub's request limit for the person's linked account is used up.${when}`
                        : `GitHub's limit for requests without an account (60 an hour for this server) is used up.${when} Linking a GitHub account in Polaris under Connected accounts (${CONNECTIONS_HUB}) raises it to 5,000 an hour.`
                );
            }
        }
        if (githubEmpty(reply)) throw new RepoFailure("That repository is empty.");
        if (reply.status === 403 && reply.headers.get("x-github-sso")) {
            throw new RepoFailure(
                `${this.owner} requires the person's linked GitHub account to authorize single sign-on before anything may read its repositories.`
            );
        }
        if (reply.status === 404 || reply.status === 403) {
            const gap = await this.appGap();
            if (gap) throw new RepoFailure(gapSentence(gap, what), gap);
        }
        if (reply.status === 404) {
            throw new RepoFailure(
                signed
                    ? `${what} was not found, or the person's linked GitHub account cannot see it.`
                    : `${what} was not found. If the repository is private, the person can link their GitHub account in Polaris under Connected accounts (${CONNECTIONS_HUB}) and ask again.`
            );
        }
        if (reply.status === 409) throw new RepoFailure("That repository is empty.");
        if (reply.status === 451)
            throw new RepoFailure("GitHub blocks that repository for legal reasons.");
        throw new RepoFailure(`GitHub answered ${reply.status} for ${what}.`);
    }

    async read<S extends z.ZodType>(path: string, schema: S, what: string): Promise<z.output<S>> {
        const reply = await this.get(path);
        await this.check(reply, what);
        const parsed = schema.safeParse(json(reply));
        if (!parsed.success)
            throw new RepoFailure(`GitHub sent an answer for ${what} that could not be read.`);
        return parsed.data;
    }
}

/** gitlab.com, anonymous. */
class GitlabClient {
    async get(path: string, most = JSON_BYTES): Promise<HostReply> {
        const reply = await call(
            `${GITLAB_API}${path}`,
            { Accept: "application/json", "User-Agent": "polaris" },
            most
        );
        if (!reply)
            throw new RepoFailure("gitlab.com could not be reached from this server right now.");
        return reply;
    }

    check(reply: HostReply, what: string): void {
        if (reply.status >= 200 && reply.status < 300) return;
        if (reply.status === 429) {
            const retry = reply.headers.get("retry-after");
            throw new RepoFailure(
                `gitlab.com is limiting requests from this server.${retry ? ` Try again in ${retry} seconds.` : " Try again in a minute."}`
            );
        }
        if (reply.status === 404 || reply.status === 401 || reply.status === 403) {
            throw new RepoFailure(
                `${what} was not found on gitlab.com, or it is private. Polaris reads public GitLab projects only.`
            );
        }
        throw new RepoFailure(`gitlab.com answered ${reply.status} for ${what}.`);
    }

    async read<S extends z.ZodType>(path: string, schema: S, what: string): Promise<z.output<S>> {
        const reply = await this.get(path);
        this.check(reply, what);
        const parsed = schema.safeParse(json(reply));
        if (!parsed.success)
            throw new RepoFailure(`gitlab.com sent an answer for ${what} that could not be read.`);
        return parsed.data;
    }
}

/** A path inside a repository: no leading or trailing slash, no `..`. */
function cleanPath(path: string | undefined): string {
    const clean = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (clean.split("/").some((part) => part === ".." || part === ".")) {
        throw new RepoFailure("A path inside a repository cannot contain . or .. segments.");
    }
    return clean;
}

/** Each segment of a path encoded, the slashes kept. */
function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

function gitlabId(repo: RepoAddress): string {
    return encodeURIComponent(repoLabel(repo));
}

/** One repository, with the clients to ask it and where in it a call is about. */
interface Located {
    repo: RepoAddress;
    /** Null for the default branch. */
    ref: string | null;
    path: string;
    github: GithubClient | null;
    gitlab: GitlabClient | null;
}

const githubCommitList = z.array(
    z.object({
        sha: z.string(),
        commit: z.object({
            message: z.string(),
            tree: z.object({ sha: z.string() }).optional(),
            author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish()
        })
    })
);

/** Whether a ref names something in the repository. */
async function refExists(located: Omit<Located, "ref" | "path">, ref: string): Promise<boolean> {
    const { repo } = located;
    if (located.github) {
        const reply = await located.github.get(
            `/repos/${repo.owner}/${repo.name}/commits?per_page=1&sha=${encodeURIComponent(ref)}`
        );
        if (reply.status === 403 || reply.status === 429)
            await located.github.check(reply, "that ref");
        return reply.status === 200;
    }
    const reply = await located.gitlab!.get(
        `/projects/${gitlabId(repo)}/repository/commits/${encodeURIComponent(ref)}`
    );
    if (reply.status === 429) located.gitlab!.check(reply, "that ref");
    return reply.status === 200;
}

/**
 * The repository, ref and path a call is about. An explicit ref or path wins;
 * otherwise they come from the address. A ref with a slash in it cannot be told
 * from the path by reading the address, so each split is tried against the host,
 * shortest ref first (the usual case costs one call), as GitHub's own pages do
 * by matching against the repository's refs.
 */
export async function locate(
    asker: Asker,
    input: { repository: string; ref?: string; path?: string }
): Promise<Located> {
    const repo = parseRepoInput(input.repository);
    if (!repo) {
        throw new RepoFailure(
            "That is not a GitHub or gitlab.com repository address. Give one such as https://github.com/owner/repo."
        );
    }
    const clients = {
        repo,
        github: repo.host === "github" ? new GithubClient(asker, repo.owner, repo.name) : null,
        gitlab: repo.host === "gitlab" ? new GitlabClient() : null
    };
    const explicitPath = input.path === undefined ? undefined : cleanPath(input.path);
    if (input.ref) {
        const ref = input.ref.trim();
        const refParts = ref.split("/");
        const fromAddress = refParts.every((part, index) => repo.rest[index] === part)
            ? repo.rest.slice(refParts.length).join("/")
            : "";
        return { ...clients, ref, path: explicitPath ?? cleanPath(fromAddress) };
    }
    const candidates = refCandidates(repo.rest);
    if (candidates.length === 0) return { ...clients, ref: null, path: explicitPath ?? "" };
    let chosen = candidates[0]!;
    if (candidates.length > 1) {
        for (const candidate of candidates) {
            if (await refExists(clients, candidate.ref)) {
                chosen = candidate;
                break;
            }
        }
    }
    return { ...clients, ref: chosen.ref, path: explicitPath ?? cleanPath(chosen.path) };
}

/** The ref to name in an answer. */
function refName(located: Located, fallback: string | null = null): string {
    return located.ref ?? fallback ?? "the default branch";
}

/** The page of a file or folder on the host, for links in the answer. */
function webLink(located: Located, kind: "tree" | "blob", ref: string, path: string): string {
    const base = repoWebUrl(located.repo);
    const tail = path ? `/${encodePath(path)}` : "";
    return located.repo.host === "github"
        ? `${base}/${kind}/${encodePath(ref)}${tail}`
        : `${base}/-/${kind}/${encodePath(ref)}${tail}`;
}

const githubRepo = z.object({
    full_name: z.string(),
    description: z.string().nullish(),
    default_branch: z.string(),
    private: z.boolean().default(false),
    archived: z.boolean().default(false),
    fork: z.boolean().default(false),
    stargazers_count: z.number().default(0),
    language: z.string().nullish(),
    topics: z.array(z.string()).default([]),
    license: z.object({ spdx_id: z.string().nullish() }).nullish(),
    pushed_at: z.string().nullish(),
    homepage: z.string().nullish()
});

const githubEntry = z.object({
    name: z.string(),
    path: z.string(),
    type: z.string(),
    size: z.number().default(0)
});

const githubFile = z.object({
    type: z.string(),
    path: z.string(),
    size: z.number().default(0),
    encoding: z.string().nullish(),
    content: z.string().nullish()
});

const gitlabProject = z.object({
    path_with_namespace: z.string(),
    description: z.string().nullish(),
    default_branch: z.string().nullish(),
    visibility: z.string().nullish(),
    archived: z.boolean().default(false),
    star_count: z.number().default(0),
    topics: z.array(z.string()).default([]),
    last_activity_at: z.string().nullish(),
    readme_url: z.string().nullish()
});

const gitlabEntry = z.object({ name: z.string(), path: z.string(), type: z.string() });

const gitlabFile = z.object({
    file_path: z.string(),
    size: z.number().default(0),
    encoding: z.string().default("base64"),
    content: z.string().default("")
});

const gitlabCommits = z.array(
    z.object({
        id: z.string(),
        title: z.string().default(""),
        author_name: z.string().nullish(),
        created_at: z.string().nullish()
    })
);

const languages = z.record(z.string(), z.number());

/** Languages as shares of the code, biggest first. */
function languageLine(bytes: Record<string, number>, percent: boolean): string {
    const entries = Object.entries(bytes).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return "";
    const total = percent ? 100 : entries.reduce((sum, [, size]) => sum + size, 0);
    return entries
        .slice(0, 8)
        .map(([name, size]) => `${name} ${((size / (total || 1)) * 100).toFixed(1)}%`)
        .join(", ");
}

/** A folder listing, folders first. */
function listingText(entries: { name: string; type: string }[]): string {
    const sorted = [...entries].sort(
        (a, b) =>
            Number(b.type === "dir" || b.type === "tree") -
                Number(a.type === "dir" || a.type === "tree") || a.name.localeCompare(b.name)
    );
    return sorted
        .slice(0, LIST_MOST)
        .map((entry) =>
            entry.type === "dir" || entry.type === "tree" ? `${entry.name}/` : entry.name
        )
        .join("\n");
}

/**
 * A file's bytes as text, or null when they are not text: a NUL byte in the
 * head, or bytes that are not UTF-8. Pure.
 */
export function textOf(bytes: Uint8Array): string | null {
    if (bytes.subarray(0, 8000).includes(0)) return null;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

/**
 * The part of a file one call shows, from `fromLine`, cut at whole lines once
 * `FILE_CHARS` is reached. Pure.
 */
export function fileWindow(
    text: string,
    fromLine = 1
): { text: string; first: number; last: number; lines: number; truncated: boolean } {
    const all = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    const lines = all.length;
    const first = Math.min(Math.max(1, fromLine), lines);
    const picked: string[] = [];
    let used = 0;
    for (let index = first - 1; index < lines; index += 1) {
        const line = all[index]!;
        if (picked.length > 0 && used + line.length + 1 > FILE_CHARS) break;
        picked.push(line.length > FILE_CHARS ? line.slice(0, FILE_CHARS) : line);
        used += line.length + 1;
    }
    const last = first + picked.length - 1;
    return { text: picked.join("\n"), first, last, lines, truncated: last < lines };
}

function decodeBase64(content: string): Uint8Array {
    return new Uint8Array(Buffer.from(content.replace(/\s+/g, ""), "base64"));
}

function sizeLabel(bytes: number): string {
    return bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : bytes >= 1024
          ? `${Math.round(bytes / 1024)} KB`
          : `${bytes} bytes`;
}

/** What every repository tool answers. */
export type RepoToolResult =
    | {
          ok: true;
          repository: string;
          ref: string;
          path: string;
          url: string;
          text: string;
          truncated?: boolean;
      }
    | { ok: false; repository: string; text: string; access?: GithubAppGap };

async function overview(located: Located): Promise<RepoToolResult> {
    const { repo } = located;
    const label = repoLabel(repo);
    const lines: string[] = [];
    let readme = "";
    let root: { name: string; path: string; type: string }[] = [];
    let ref = located.ref ?? "";
    if (located.github) {
        const client = located.github;
        const base = `/repos/${repo.owner}/${repo.name}`;
        const info = await client.read(base, githubRepo, "That repository");
        ref = located.ref ?? info.default_branch;
        const refQuery = `?ref=${encodeURIComponent(ref)}`;
        const [langs, readmeReply, rootReply] = await Promise.all([
            client.read(`${base}/languages`, languages, "its languages").catch(() => ({})),
            client.get(`${base}/readme${refQuery}`, "application/vnd.github.raw", 256 * 1024),
            client.get(`${base}/contents${refQuery}`)
        ]);
        if (!githubEmpty(rootReply)) await client.check(rootReply, `The branch ${ref}`);
        root = z.array(githubEntry).catch([]).parse(json(rootReply));
        if (readmeReply.status === 200 && readmeReply.bytes)
            readme = textOf(readmeReply.bytes) ?? "";
        lines.push(
            `repository: ${info.full_name} on GitHub${info.private ? " (private)" : ""}${info.archived ? " (archived)" : ""}${info.fork ? " (a fork)" : ""}`,
            `default branch: ${info.default_branch}`,
            info.description ? `description: ${info.description}` : "",
            `languages: ${languageLine(langs, false) || info.language || "not reported"}`,
            info.topics.length ? `topics: ${info.topics.join(", ")}` : "",
            info.license?.spdx_id ? `license: ${info.license.spdx_id}` : "",
            `stars: ${info.stargazers_count}`,
            info.pushed_at ? `last push: ${info.pushed_at}` : "",
            info.homepage ? `homepage: ${info.homepage}` : ""
        );
    } else {
        const client = located.gitlab!;
        const id = gitlabId(repo);
        const info = await client.read(`/projects/${id}`, gitlabProject, "That project");
        ref = located.ref ?? info.default_branch ?? "";
        if (!ref)
            return {
                ok: true,
                repository: label,
                ref: "",
                path: "",
                url: repoWebUrl(repo),
                text: "That project is empty."
            };
        const [langs, rootReply] = await Promise.all([
            client.read(`/projects/${id}/languages`, languages, "its languages").catch(() => ({})),
            client.get(
                `/projects/${id}/repository/tree?per_page=100&ref=${encodeURIComponent(ref)}`
            )
        ]);
        client.check(rootReply, `The branch ${ref}`);
        root = z.array(gitlabEntry).catch([]).parse(json(rootReply));
        const readmeName = info.readme_url?.split("/").pop();
        const readmeEntry =
            root.find((entry) => entry.type === "blob" && entry.name === readmeName) ??
            root.find((entry) => entry.type === "blob" && /^readme(\.|$)/i.test(entry.name));
        if (readmeEntry) {
            const reply = await client.get(
                `/projects/${id}/repository/files/${encodeURIComponent(readmeEntry.path)}/raw?ref=${encodeURIComponent(ref)}`,
                256 * 1024
            );
            if (reply.status === 200 && reply.bytes) readme = textOf(reply.bytes) ?? "";
        }
        lines.push(
            `repository: ${info.path_with_namespace} on gitlab.com${info.visibility && info.visibility !== "public" ? ` (${info.visibility})` : ""}${info.archived ? " (archived)" : ""}`,
            `default branch: ${info.default_branch ?? "none"}`,
            info.description ? `description: ${info.description}` : "",
            `languages: ${languageLine(langs, true) || "not reported"}`,
            info.topics.length ? `topics: ${info.topics.join(", ")}` : "",
            `stars: ${info.star_count}`,
            info.last_activity_at ? `last activity: ${info.last_activity_at}` : ""
        );
    }
    const body = [
        ...lines.filter(Boolean),
        "",
        `top level at ${ref}:`,
        listingText(root) || "(empty)",
        readme
            ? `\nREADME (first ${README_CHARS} characters):\n${readme.slice(0, README_CHARS)}`
            : ""
    ].join("\n");
    const url = webLink(located, "tree", ref, "");
    return { ok: true, repository: label, ref, path: "", url, text: fenceUntrusted(url, body) };
}

async function listFiles(located: Located): Promise<RepoToolResult> {
    const { repo, path } = located;
    const label = repoLabel(repo);
    let entries: { name: string; type: string }[];
    let more = false;
    let ref = located.ref;
    const where = path ? `The folder ${path}` : "That repository";
    if (located.github) {
        const query = located.ref ? `?ref=${encodeURIComponent(located.ref)}` : "";
        const reply = await located.github.get(
            `/repos/${repo.owner}/${repo.name}/contents${path ? `/${encodePath(path)}` : ""}${query}`
        );
        await located.github.check(reply, where);
        const data = json(reply);
        if (!Array.isArray(data)) {
            return {
                ok: false,
                repository: label,
                text: `${path} is a file, not a folder: read it with ${REPO_TOOLS.read}.`
            };
        }
        entries = z.array(githubEntry).catch([]).parse(data);
        more = entries.length >= 1000;
    } else {
        const client = located.gitlab!;
        const id = gitlabId(repo);
        if (!ref) {
            ref =
                (await client.read(`/projects/${id}`, gitlabProject, "That project"))
                    .default_branch ?? null;
            if (!ref) return { ok: false, repository: label, text: "That project is empty." };
        }
        const reply = await client.get(
            `/projects/${id}/repository/tree?per_page=100&ref=${encodeURIComponent(ref)}${path ? `&path=${encodeURIComponent(path)}` : ""}`
        );
        client.check(reply, where);
        entries = z.array(gitlabEntry).catch([]).parse(json(reply));
        more = Boolean(reply.headers.get("x-next-page"));
        if (entries.length === 0 && path) {
            return {
                ok: false,
                repository: label,
                text: `${path} is not a folder at ${ref}. If it is a file, read it with ${REPO_TOOLS.read}.`
            };
        }
    }
    const shown = refName(located, ref);
    const url = webLink(located, "tree", ref ?? located.ref ?? "HEAD", path);
    const head = `${label}${path ? `/${path}` : ""} at ${shown}: ${entries.length} entries${more || entries.length > LIST_MOST ? ", more not shown" : ""}`;
    return {
        ok: true,
        repository: label,
        ref: shown,
        path,
        url,
        truncated: more || entries.length > LIST_MOST,
        text: fenceUntrusted(url, `${head}\n${listingText(entries) || "(empty)"}`)
    };
}

async function readFile(located: Located, fromLine: number | undefined): Promise<RepoToolResult> {
    const { repo, path } = located;
    const label = repoLabel(repo);
    if (!path)
        return {
            ok: false,
            repository: label,
            text: `Name the file to read, or list the folders with ${REPO_TOOLS.list}.`
        };
    let bytes: Uint8Array;
    let ref = located.ref;
    if (located.github) {
        const query = located.ref ? `?ref=${encodeURIComponent(located.ref)}` : "";
        const reply = await located.github.get(
            `/repos/${repo.owner}/${repo.name}/contents${path ? `/${encodePath(path)}` : ""}${query}`
        );
        await located.github.check(reply, `The file ${path}`);
        const data = json(reply);
        if (Array.isArray(data)) {
            return {
                ok: false,
                repository: label,
                text: `${path} is a folder: list it with ${REPO_TOOLS.list}.`
            };
        }
        const file = githubFile.safeParse(data);
        if (!file.success)
            return {
                ok: false,
                repository: label,
                text: `GitHub sent an answer for ${path} that could not be read.`
            };
        if (file.data.type !== "file") {
            return {
                ok: false,
                repository: label,
                text: `${path} is a ${file.data.type}, not a file that can be read.`
            };
        }
        if (file.data.size > FILE_BYTES || file.data.encoding !== "base64") {
            return {
                ok: false,
                repository: label,
                text: `${path} is ${sizeLabel(file.data.size)}, more than the ${sizeLabel(FILE_BYTES)} Polar reads.`
            };
        }
        bytes = decodeBase64(file.data.content ?? "");
    } else {
        const client = located.gitlab!;
        const id = gitlabId(repo);
        if (!ref) {
            ref =
                (await client.read(`/projects/${id}`, gitlabProject, "That project"))
                    .default_branch ?? null;
            if (!ref) return { ok: false, repository: label, text: "That project is empty." };
        }
        const reply = await client.get(
            `/projects/${id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
            Math.ceil(FILE_BYTES * 1.4) + 64 * 1024
        );
        if (reply.tooBig) {
            return {
                ok: false,
                repository: label,
                text: `${path} is more than the ${sizeLabel(FILE_BYTES)} Polar reads.`
            };
        }
        client.check(reply, `The file ${path}`);
        const file = gitlabFile.safeParse(json(reply));
        if (!file.success)
            return {
                ok: false,
                repository: label,
                text: `gitlab.com sent an answer for ${path} that could not be read.`
            };
        if (file.data.size > FILE_BYTES) {
            return {
                ok: false,
                repository: label,
                text: `${path} is ${sizeLabel(file.data.size)}, more than the ${sizeLabel(FILE_BYTES)} Polar reads.`
            };
        }
        bytes =
            file.data.encoding === "base64"
                ? decodeBase64(file.data.content)
                : new TextEncoder().encode(file.data.content);
    }
    const text = textOf(bytes);
    if (text === null) {
        return {
            ok: false,
            repository: label,
            text: `${path} is a binary file (${sizeLabel(bytes.length)}), not text that can be read.`
        };
    }
    const window = fileWindow(text, fromLine);
    const shown = refName(located, ref);
    const url = webLink(located, "blob", ref ?? located.ref ?? "HEAD", path);
    const head = window.truncated
        ? `${path} at ${shown}: lines ${window.first}-${window.last} of ${window.lines}. Call again with fromLine ${window.last + 1} for the rest.`
        : `${path} at ${shown}: ${window.lines} lines${window.first > 1 ? `, from line ${window.first}` : ""}.`;
    return {
        ok: true,
        repository: label,
        ref: shown,
        path,
        url,
        truncated: window.truncated,
        text: `${head}\n${fenceUntrusted(url, window.text)}`
    };
}

/**
 * Whether a path matches what was asked: every word appears in it, or, with a
 * `*`, the whole path matches the pattern. Case-insensitive. Pure.
 */
export function pathMatches(path: string, query: string): boolean {
    const lower = path.toLowerCase();
    const asked = query.trim().toLowerCase();
    if (asked.includes("*")) {
        const pattern = asked
            .split("*")
            .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*");
        const name = lower.split("/").pop() ?? lower;
        const anchored = new RegExp(`^${pattern}$`);
        return anchored.test(lower) || anchored.test(name);
    }
    return asked
        .split(/\s+/)
        .filter(Boolean)
        .every((word) => lower.includes(word));
}

const githubTree = z.object({
    tree: z.array(z.object({ path: z.string(), type: z.string() })),
    truncated: z.boolean().default(false)
});

const githubCodeSearch = z.object({
    total_count: z.number().default(0),
    items: z.array(
        z.object({
            path: z.string(),
            text_matches: z.array(z.object({ fragment: z.string() })).default([])
        })
    )
});

const gitlabBlobs = z.array(
    z.object({ path: z.string(), startline: z.number().nullish(), data: z.string().default("") })
);

async function search(
    located: Located,
    query: string,
    inContents: boolean
): Promise<RepoToolResult> {
    const { repo } = located;
    const label = repoLabel(repo);
    const sections: string[] = [];
    let truncated = false;
    let ref = located.ref;
    let paths: string[] = [];
    if (located.github) {
        const client = located.github;
        const base = `/repos/${repo.owner}/${repo.name}`;
        const head = await client.read(
            `${base}/commits?per_page=1${ref ? `&sha=${encodeURIComponent(ref)}` : ""}`,
            githubCommitList,
            ref ? `The ref ${ref}` : "That repository"
        );
        const treeSha = head[0]?.commit.tree?.sha;
        if (!treeSha) return { ok: false, repository: label, text: "That repository is empty." };
        const treeReply = await client.get(
            `${base}/git/trees/${treeSha}?recursive=1`,
            "application/vnd.github+json",
            TREE_BYTES
        );
        await client.check(treeReply, "its file tree");
        if (treeReply.tooBig) {
            truncated = true;
        } else {
            const tree = githubTree.safeParse(json(treeReply));
            if (!tree.success)
                throw new RepoFailure(
                    "GitHub sent an answer for its file tree that could not be read."
                );
            truncated = tree.data.truncated;
            paths = tree.data.tree
                .filter((entry) => entry.type === "blob")
                .map((entry) => entry.path);
        }
        if (inContents) {
            if (!(await client.signedIn())) {
                sections.push(
                    `Searching inside files on GitHub needs a signed-in account; the person can link GitHub in Polaris under Connected accounts (${CONNECTIONS_HUB}). Only file paths were searched.`
                );
            } else {
                const reply = await client.get(
                    `/search/code?per_page=20&q=${encodeURIComponent(`${query} repo:${repo.owner}/${repo.name}`)}`,
                    "application/vnd.github.text-match+json"
                );
                await client.check(reply, "That search");
                const found = githubCodeSearch.safeParse(json(reply));
                if (found.success) {
                    sections.push(
                        `inside files (default branch, ${found.data.total_count} matches):`,
                        found.data.items
                            .map(
                                (item) =>
                                    `${item.path}\n${item.text_matches.map((match) => `  ${match.fragment.trim().replace(/\n/g, "\n  ")}`).join("\n")}`
                            )
                            .join("\n") || "(none)"
                    );
                }
            }
        }
    } else {
        const client = located.gitlab!;
        const id = gitlabId(repo);
        if (!ref) {
            ref =
                (await client.read(`/projects/${id}`, gitlabProject, "That project"))
                    .default_branch ?? null;
            if (!ref) return { ok: false, repository: label, text: "That project is empty." };
        }
        for (let page = 1; page <= GITLAB_TREE_PAGES; page += 1) {
            const reply = await client.get(
                `/projects/${id}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`
            );
            client.check(reply, `The branch ${ref}`);
            const entries = z.array(gitlabEntry).catch([]).parse(json(reply));
            paths.push(
                ...entries.filter((entry) => entry.type === "blob").map((entry) => entry.path)
            );
            const next = reply.headers.get("x-next-page");
            if (!next) break;
            if (page === GITLAB_TREE_PAGES) truncated = true;
        }
        if (inContents) {
            const reply = await client.get(
                `/projects/${id}/search?scope=blobs&per_page=20&ref=${encodeURIComponent(ref)}&search=${encodeURIComponent(query)}`
            );
            if (reply.status === 401 || reply.status === 403) {
                sections.push(
                    "gitlab.com only searches inside files for a signed-in account. Only file paths were searched."
                );
            } else {
                client.check(reply, "That search");
                const found = gitlabBlobs.catch([]).parse(json(reply));
                sections.push(
                    "inside files:",
                    found
                        .map(
                            (item) =>
                                `${item.path}${item.startline ? `:${item.startline}` : ""}\n  ${item.data.trim().replace(/\n/g, "\n  ")}`
                        )
                        .join("\n") || "(none)"
                );
            }
        }
    }
    const matched = paths.filter((path) => pathMatches(path, query));
    const shown = refName(located, ref);
    const url = webLink(located, "tree", ref ?? "HEAD", "");
    const pathSection = [
        `paths matching "${query}" at ${shown}: ${matched.length}${matched.length > SEARCH_MOST ? `, first ${SEARCH_MOST} shown` : ""}${truncated ? " (the repository is too big to list whole; some paths were not searched)" : ""}`,
        matched.slice(0, SEARCH_MOST).join("\n") || "(none)"
    ];
    return {
        ok: true,
        repository: label,
        ref: shown,
        path: "",
        url,
        truncated,
        text: fenceUntrusted(url, [...pathSection, "", ...sections].join("\n").trim())
    };
}

async function commits(located: Located, most: number): Promise<RepoToolResult> {
    const { repo, path } = located;
    const label = repoLabel(repo);
    let rows: string[];
    if (located.github) {
        const list = await located.github.read(
            `/repos/${repo.owner}/${repo.name}/commits?per_page=${most}${located.ref ? `&sha=${encodeURIComponent(located.ref)}` : ""}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
            githubCommitList,
            located.ref ? `The ref ${located.ref}` : "That repository"
        );
        rows = list.map(
            (entry) =>
                `${entry.sha.slice(0, 7)} ${entry.commit.author?.date?.slice(0, 10) ?? ""} ${entry.commit.author?.name ?? ""}: ${entry.commit.message.split("\n")[0]}`
        );
    } else {
        const list = await located.gitlab!.read(
            `/projects/${gitlabId(repo)}/repository/commits?per_page=${most}${located.ref ? `&ref_name=${encodeURIComponent(located.ref)}` : ""}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
            gitlabCommits,
            located.ref ? `The ref ${located.ref}` : "That project"
        );
        rows = list.map(
            (entry) =>
                `${entry.id.slice(0, 7)} ${entry.created_at?.slice(0, 10) ?? ""} ${entry.author_name ?? ""}: ${entry.title}`
        );
    }
    const shown = refName(located);
    const url =
        repo.host === "github" ? `${repoWebUrl(repo)}/commits` : `${repoWebUrl(repo)}/-/commits`;
    return {
        ok: true,
        repository: label,
        ref: shown,
        path,
        url,
        text: fenceUntrusted(
            url,
            `latest commits on ${shown}${path ? ` touching ${path}` : ""}:\n${rows.join("\n") || "(none)"}`
        )
    };
}

const repository = z
    .string()
    .trim()
    .min(3)
    .max(2048)
    .describe(
        "The repository: its address (https://github.com/owner/repo, a gitlab.com project, or any link inside one) or GitHub's owner/repo."
    );
const ref = z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Branch, tag or commit. Default: the one in the address, else the default branch.");
const path = z
    .string()
    .trim()
    .max(1024)
    .optional()
    .describe("Path inside the repository, such as src/app or composer.json.");

const overviewInput = z.object({ repository, ref });
const listInput = z.object({ repository, ref, path });
const readInput = z.object({
    repository,
    ref,
    path,
    fromLine: z
        .number()
        .int()
        .min(1)
        .max(10_000_000)
        .optional()
        .describe("First line to show, to continue a file that was cut.")
});
const searchInput = z.object({
    repository,
    ref,
    query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Words in a file's path, or a pattern such as *.csproj or Dockerfile*."),
    inContents: z
        .boolean()
        .default(false)
        .describe("Also search inside files (needs a signed-in account on the host).")
});
const commitsInput = z.object({
    repository,
    ref,
    path,
    limit: z.number().int().min(1).max(30).default(10)
});

function schema<T extends z.ZodType>(input: T): FlexibleSchema<z.infer<T>> {
    return input as unknown as FlexibleSchema<z.infer<T>>;
}

/** Runs one tool, turning a refusal into the answer the model reads. */
async function guarded(
    written: { repository: string },
    run: () => Promise<RepoToolResult>
): Promise<RepoToolResult> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof RepoFailure) {
            return {
                ok: false,
                repository: written.repository,
                text: error.message,
                ...(error.access ? { access: error.access } : {})
            };
        }
        console.error("polar: a repository read failed", error);
        return {
            ok: false,
            repository: written.repository,
            text: "The repository could not be read. Polaris has logged why."
        };
    }
}

/** The repository tools, as one person. All read-only, none needs an approval. */
export function polarRepoTools(userId: string): ToolSet {
    const asker: Asker = { userId };
    return {
        [REPO_TOOLS.overview]: tool({
            description:
                "Get a GitHub or GitLab repository's overview: description, default branch, languages, top-level files and the start of its README. Start here for a question about a repository.",
            inputSchema: schema(overviewInput),
            execute: (input) => guarded(input, async () => overview(await locate(asker, input)))
        }),
        [REPO_TOOLS.list]: tool({
            description: "List the files and folders at a path in a GitHub or GitLab repository.",
            inputSchema: schema(listInput),
            execute: (input) => guarded(input, async () => listFiles(await locate(asker, input)))
        }),
        [REPO_TOOLS.read]: tool({
            description:
                "Read a text file from a GitHub or GitLab repository, such as composer.json, package.json, a Dockerfile or source code. Long files come in parts.",
            inputSchema: schema(readInput),
            execute: (input) =>
                guarded(input, async () => readFile(await locate(asker, input), input.fromLine))
        }),
        [REPO_TOOLS.search]: tool({
            description:
                "Find files in a GitHub or GitLab repository by path or name pattern, and optionally search inside them.",
            inputSchema: schema(searchInput),
            execute: (input) =>
                guarded(input, async () =>
                    search(await locate(asker, input), input.query, input.inContents)
                )
        }),
        [REPO_TOOLS.commits]: tool({
            description:
                "List the latest commits of a GitHub or GitLab repository, optionally only those touching a path.",
            inputSchema: schema(commitsInput),
            execute: (input) =>
                guarded(input, async () => commits(await locate(asker, input), input.limit))
        })
    };
}
