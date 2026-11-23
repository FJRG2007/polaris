/**
 * Every repository a person can start a session on: what their own linked
 * GitHub accounts reach - the same list Deploy's picker reads
 * (`listReposForUser`) - merged with the repositories already set up for
 * agents, a page at a time.
 *
 * A session runs on an `AgentRepo` row, so a repository that has none yet is
 * listed under a `github:` reference and gets its row the moment it is picked
 * (`connectSessionRepo`). That row starts with the review bot off: picking a
 * repository to work in is not asking Polaris to answer its pull requests.
 */

import { prisma } from "@polaris/db";
import type { GithubRepo } from "@/lib/github-service";
import { listReposForUser } from "@/lib/github-access";
import { providersFor } from "@/lib/agents/model-keys";
import { firstModelOf } from "@/lib/agents/model-default";
import type { RepoOption, RepoOptionsRequest } from "@/lib/agents/repo-options";
import { GITHUB_REPO_PREFIX } from "@/lib/agents/repo-ref";
import { defaultConfigFor, upsertAgentRepo } from "@/lib/agents/agent-repo-service";
import { githubInstallGapForRepo, type GithubInstallGap } from "@/lib/github-app-reach";

/** Most agent rows read to merge with GitHub's list: far past anybody's real count. */
const CONNECTED_LIMIT = 2000;

/** How long one person's GitHub list is reused: the picker searches and pages
 *  on every keystroke, and each read is a request per installation. */
const LIST_TTL_MS = 30_000;
/** People whose lists are kept at once; the oldest goes first. */
const LIST_CACHE_MAX = 500;

const listCache = new Map<string, { at: number; value: Promise<GithubRepo[]> }>();

/** One person's GitHub repositories, read once per `LIST_TTL_MS` and shared by
 *  every request that asks meanwhile. A GitHub that will not answer is an
 *  empty list, not kept, so the next request asks again. */
export function cachedReposForUser(userId: string): Promise<GithubRepo[]> {
    const hit = listCache.get(userId);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
    const value = listReposForUser(userId).catch(() => {
        listCache.delete(userId);
        return [] as GithubRepo[];
    });
    listCache.delete(userId);
    listCache.set(userId, { at: Date.now(), value });
    if (listCache.size > LIST_CACHE_MAX) {
        const oldest = listCache.keys().next().value;
        if (oldest !== undefined) listCache.delete(oldest);
    }
    return value;
}

function encodeCursor(name: string): string {
    return Buffer.from(JSON.stringify([name])).toString("base64url");
}

function decodeCursor(raw: string | null): string | null {
    if (!raw) return null;
    try {
        const [name] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown[];
        return typeof name === "string" ? name : null;
    } catch {
        return null;
    }
}

const sortKey = (name: string) => name.toLowerCase();

/**
 * One page of the merged list, ordered by name and continued after the last
 * name served. Pure, so the merge is asserted without GitHub or a database.
 *
 * An enabled agent row is always listed (GitHub may be down, or the account
 * unlinked since); a disabled one only while GitHub still lists it, since it
 * is then just a repository the person reaches.
 */
export function mergeRepoPage(
    connected: readonly { id: string; repoFullName: string; enabled: boolean }[],
    github: readonly GithubRepo[],
    request: Pick<RepoOptionsRequest, "query" | "cursor" | "limit">
): { items: RepoOption[]; next: string | null } {
    const byName = new Map<string, RepoOption>();
    const rows = new Map(connected.map((row) => [sortKey(row.repoFullName), row]));
    for (const repo of github) {
        const key = sortKey(repo.fullName);
        const row = rows.get(key);
        byName.set(key, {
            id: row ? row.id : `${GITHUB_REPO_PREFIX}${repo.fullName}`,
            name: row ? row.repoFullName : repo.fullName
        });
    }
    for (const row of connected) {
        const key = sortKey(row.repoFullName);
        if (row.enabled && !byName.has(key)) byName.set(key, { id: row.id, name: row.repoFullName });
    }
    const query = request.query.trim().toLowerCase();
    const after = decodeCursor(request.cursor);
    const matching = [...byName.entries()]
        .filter(([key]) => (!query || key.includes(query)) && (after === null || key > after))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const page = matching.slice(0, request.limit);
    const last = page[page.length - 1];
    return {
        items: page.map(([, option]) => option),
        next: matching.length > request.limit && last ? encodeCursor(last[0]) : null
    };
}

/** One page of everything `ownerId` can start a session on, or the agent rows
 *  named by id (enabled or not: a row a session already picked). */
export async function reachableRepoPage(
    ownerId: string,
    request: RepoOptionsRequest
): Promise<{ items: RepoOption[]; next: string | null }> {
    if (request.ids) {
        const rows = await prisma.agentRepo.findMany({
            where: { ownerId, id: { in: [...request.ids] } },
            select: { id: true, repoFullName: true },
            orderBy: { repoFullName: "asc" }
        });
        return { items: rows.map((row) => ({ id: row.id, name: row.repoFullName })), next: null };
    }
    const [connected, github] = await Promise.all([
        prisma.agentRepo.findMany({
            where: { ownerId },
            select: { id: true, repoFullName: true, enabled: true },
            orderBy: { repoFullName: "asc" },
            take: CONNECTED_LIMIT
        }),
        cachedReposForUser(ownerId)
    ]);
    return mergeRepoPage(connected, github, request);
}

/** Why a repository could not be set up for a session. */
export type ConnectRefusal =
    | { kind: "unchecked" }
    | { kind: "unreachable" }
    | { kind: "gap"; gap: GithubInstallGap };

/**
 * The agent row a session on `repoFullName` runs on: the existing one, or a
 * new one with the review bot off, made only for a repository this person's
 * own linked GitHub account reaches - never on the strength of the name alone,
 * since sessions clone with credentials that reach more than that.
 */
export async function connectSessionRepo(
    ownerId: string,
    repoFullName: string
): Promise<{ id: string; name: string } | ConnectRefusal> {
    const existing = await prisma.agentRepo.findFirst({
        where: { ownerId, repoFullName: { equals: repoFullName, mode: "insensitive" } },
        select: { id: true, repoFullName: true }
    });
    if (existing) return { id: existing.id, name: existing.repoFullName };

    // Asked fresh rather than from the picker's cache: this is the check.
    const reachable = await listReposForUser(ownerId).catch(() => null);
    if (!reachable) return { kind: "unchecked" };
    const match = reachable.find(
        (repo) => repo.fullName.toLowerCase() === repoFullName.toLowerCase()
    );
    if (!match) {
        const gap = await githubInstallGapForRepo(ownerId, repoFullName).catch(() => null);
        return gap ? { kind: "gap", gap } : { kind: "unreachable" };
    }

    const { advice: _advice, ...config } = await defaultConfigFor(
        ownerId,
        match.fullName,
        match.private,
        firstModelOf(await providersFor(ownerId))
    );
    const saved = await upsertAgentRepo(ownerId, {
        repoFullName: match.fullName,
        installationId: match.fullName.split("/")[0] ?? "",
        isPrivate: match.private,
        config: { ...config, enabled: false }
    });
    return { id: saved.id, name: match.fullName };
}
