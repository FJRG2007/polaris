/**
 * Skills from elsewhere: the public skills.sh directory, a GitHub repository,
 * or any address that serves a `SKILL.md`.
 *
 * skills.sh is searched and downloaded through the two endpoints its own
 * `skills` command line uses (`/api/search`, `/api/download/...`), which answer
 * without a key; the documented `/api/v1` ones need a Vercel deployment's token,
 * which a self-hosted Polaris does not have. A repository is read the way that
 * command reads one: its tree from GitHub's API, each `SKILL.md` from
 * raw.githubusercontent.com.
 *
 * Every request goes through `safe-fetch`, so an address somebody typed is
 * checked like any other, and every answer is size-capped and validated before
 * it is read. Nothing here writes: it returns candidates for the person to look
 * at and add.
 *
 * Server-only.
 */

import { z } from "zod";
import { follow, readCapped, safeUrl } from "@/lib/safe-fetch";
import { readSkillBundle, readSkillFile, type SkillCandidate } from "@/lib/polar/skills/skill-file";

const DIRECTORY = "https://skills.sh";
/** A skill file this big is not instructions; the editor holds 20,000 characters. */
const FILE_BYTES = 256 * 1024;
/** A repository tree; the largest monorepos are cut off by GitHub before this. */
const TREE_BYTES = 8 * 1024 * 1024;
const JSON_BYTES = 2 * 1024 * 1024;
/** More than anyone reviews in one import. */
export const IMPORT_MAX = 30;
/** Downloads at once from one repository. */
const PARALLEL = 4;

export type RemoteRefusal = "address" | "unreachable" | "nothing" | "too_many";

export interface DirectoryEntry {
    /** `owner/repo/skill`, the directory's own id. */
    readonly id: string;
    readonly name: string;
    /** `owner/repo`. */
    readonly source: string;
    readonly installs: number;
}

const searchSchema = z.object({
    skills: z
        .array(
            z.object({
                id: z.string().min(1).max(300),
                source: z.string().min(1).max(200),
                name: z.string().min(1).max(200),
                installs: z.number().nonnegative().catch(0)
            })
        )
        .max(200)
});

const downloadSchema = z.object({
    files: z
        .array(z.object({ path: z.string().max(500), contents: z.string() }))
        .max(500)
        .nullable()
});

const auditSchema = z.object({
    audits: z
        .array(
            z.object({
                provider: z.string().max(200),
                status: z.string().max(40),
                riskLevel: z.string().max(40).optional()
            })
        )
        .max(50)
});

const treeSchema = z.object({
    truncated: z.boolean().optional(),
    tree: z.array(z.object({ path: z.string(), type: z.string() })).max(500_000)
});

/** A directory id as the endpoints take it: three plain path segments. */
const ID = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.:-]{1,200}$/;
const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

export function isDirectoryId(id: string): boolean {
    return ID.test(id) && !id.split("/").some((part) => part === "." || part === "..");
}

async function fetchText(
    address: string,
    accept: string,
    maxBytes: number
): Promise<string | null> {
    const url = safeUrl(address, 4096);
    if (!url) return null;
    const response = await follow(url, accept);
    if (!response) return null;
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    const bytes = await readCapped(response, maxBytes);
    return bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : null;
}

async function fetchJson(address: string, maxBytes = JSON_BYTES): Promise<unknown> {
    const body = await fetchText(address, "application/json", maxBytes);
    if (body === null) return undefined;
    try {
        return JSON.parse(body) as unknown;
    } catch {
        return undefined;
    }
}

/** The directory's matches for `query`, or null when it could not be asked. */
export async function searchDirectory(query: string, limit = 20): Promise<DirectoryEntry[] | null> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const parsed = searchSchema.safeParse(await fetchJson(`${DIRECTORY}/api/search?${params}`));
    if (!parsed.success) return null;
    return parsed.data.skills
        .filter((entry) => isDirectoryId(entry.id))
        .map(({ id, name, source, installs }) => ({ id, name, source, installs }));
}

/** What the directory's audits say about a skill: the worst status any of them gave. */
export interface DirectoryAudit {
    readonly status: "pass" | "warn" | "fail" | null;
    readonly flaggedBy: string[];
}

export async function directoryAudit(id: string): Promise<DirectoryAudit> {
    if (!isDirectoryId(id)) return { status: null, flaggedBy: [] };
    const parsed = auditSchema.safeParse(await fetchJson(`${DIRECTORY}/api/v1/skills/audit/${id}`));
    if (!parsed.success || parsed.data.audits.length === 0) return { status: null, flaggedBy: [] };
    const flagged = parsed.data.audits.filter((audit) => audit.status.toLowerCase() !== "pass");
    const failed = flagged.some((audit) => audit.status.toLowerCase() === "fail");
    return {
        status: failed ? "fail" : flagged.length > 0 ? "warn" : "pass",
        flaggedBy: flagged.map((audit) => audit.provider).slice(0, 10)
    };
}

/** One directory skill, read from its snapshot. */
export async function directorySkill(id: string): Promise<SkillCandidate | RemoteRefusal> {
    if (!isDirectoryId(id)) return "address";
    const [owner, repo, slug] = id.split("/") as [string, string, string];
    const parsed = downloadSchema.safeParse(
        await fetchJson(
            `${DIRECTORY}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`,
            FILE_BYTES * 8
        )
    );
    if (!parsed.success) return "unreachable";
    const file = parsed.data.files?.find((entry) => entry.path === "SKILL.md");
    if (!file) return "nothing";
    return readSkillFile(file.contents, slug, id);
}

/** A GitHub address read as owner, repository, ref and path. */
export interface RepoAddress {
    readonly owner: string;
    readonly repo: string;
    /** `HEAD` when the address names no branch. */
    readonly ref: string;
    readonly path: string;
    /** The address points at a file rather than a folder. */
    readonly file: boolean;
}

export function repoAddress(raw: string): RepoAddress | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const host = url.hostname.toLowerCase();
    if (host === "raw.githubusercontent.com") {
        const [owner, repo, ref, ...rest] = parts;
        if (!owner || !repo || !ref || rest.length === 0) return null;
        return checked({ owner, repo, ref, path: rest.join("/"), file: true });
    }
    if (host !== "github.com" && host !== "www.github.com") return null;
    const [owner, rawRepo, kind, ref, ...rest] = parts;
    const repo = rawRepo?.replace(/\.git$/, "");
    if (!owner || !repo) return null;
    if (!kind) return checked({ owner, repo, ref: "HEAD", path: "", file: false });
    if ((kind !== "tree" && kind !== "blob") || !ref) return null;
    return checked({ owner, repo, ref, path: rest.join("/"), file: kind === "blob" });
}

function checked(address: RepoAddress): RepoAddress | null {
    if (!SEGMENT.test(address.owner) || !SEGMENT.test(address.repo)) return null;
    if (address.ref.length > 200 || /[\s\\]|\.\./.test(address.ref)) return null;
    if (address.path.split("/").some((part) => part === ".." || part === ".")) return null;
    return address;
}

function rawAddress(at: RepoAddress, path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${at.owner}/${at.repo}/${encodeURIComponent(at.ref)}/${encoded}`;
}

/** The folder a `SKILL.md` sits in, which names a skill whose file does not. */
function folderName(path: string, fallback: string): string {
    const parts = path.split("/");
    return parts.length > 1 ? (parts.at(-2) ?? fallback) : fallback;
}

async function inParallel<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await run(items[index]!);
        }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
    return results;
}

/** Every skill a repository, a folder of it, or one file of it holds. */
export async function repositorySkills(at: RepoAddress): Promise<SkillCandidate[] | RemoteRefusal> {
    if (at.file) {
        const body = await fetchText(rawAddress(at, at.path), "text/plain", FILE_BYTES);
        if (body === null) return "unreachable";
        return [
            readSkillFile(body, folderName(at.path, at.repo), `${at.owner}/${at.repo}/${at.path}`)
        ];
    }
    const tree = treeSchema.safeParse(
        await fetchJson(
            `https://api.github.com/repos/${at.owner}/${at.repo}/git/trees/${encodeURIComponent(at.ref)}?recursive=1`,
            TREE_BYTES
        )
    );
    if (!tree.success) return "unreachable";
    const prefix = at.path ? `${at.path.replace(/\/+$/, "")}/` : "";
    const files = tree.data.tree
        .filter(
            (entry) =>
                entry.type === "blob" &&
                entry.path.startsWith(prefix) &&
                (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
        )
        .map((entry) => entry.path);
    if (files.length === 0) return "nothing";
    if (files.length > IMPORT_MAX) return "too_many";
    const read = await inParallel(files, async (path) => {
        const body = await fetchText(rawAddress(at, path), "text/plain", FILE_BYTES);
        return body === null
            ? null
            : readSkillFile(body, folderName(path, at.repo), `${at.owner}/${at.repo}/${path}`);
    });
    const found = read.filter((entry): entry is SkillCandidate => entry !== null);
    return found.length > 0 ? found : "unreachable";
}

/** A skills.sh page address read as the directory id it shows. */
export function directoryIdOf(raw: string): string | null {
    try {
        const url = new URL(raw.trim());
        const host = url.hostname.toLowerCase();
        if (host !== "skills.sh" && host !== "www.skills.sh") return null;
        const id = url.pathname.split("/").filter(Boolean).slice(0, 3).join("/");
        return isDirectoryId(id) ? id : null;
    } catch {
        return null;
    }
}

/** Whatever an address holds: a directory page, a repository, or a file served anywhere. */
export async function skillsAt(address: string): Promise<SkillCandidate[] | RemoteRefusal> {
    const directory = directoryIdOf(address);
    if (directory) {
        const found = await directorySkill(directory);
        return typeof found === "string" ? found : [found];
    }
    const repo = repoAddress(address);
    if (repo) return repositorySkills(repo);
    const url = safeUrl(address.trim(), 4096);
    if (!url) return "address";
    const body = await fetchText(url.href, "text/markdown,text/plain,application/json", FILE_BYTES);
    if (body === null) return "unreachable";
    const bundle = readSkillBundle(body, url.href);
    if (bundle) return bundle.length > IMPORT_MAX ? "too_many" : bundle;
    const name = url.pathname.split("/").filter(Boolean);
    const fallback =
        name.at(-1)?.toLowerCase() === "skill.md"
            ? (name.at(-2) ?? url.hostname)
            : (name.at(-1) ?? url.hostname);
    return [readSkillFile(body, fallback.replace(/\.md$/i, ""), url.href)];
}
