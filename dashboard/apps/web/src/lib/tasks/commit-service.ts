/**
 * Commits attached to a task.
 *
 * The link is stored, not looked up. What a task is worth six months later is
 * the sentence "this is the change that did it", and that sentence has to
 * survive the branch being deleted, the repository going private, and Polaris
 * losing its GitHub token. So the message, author and date are copied in at the
 * moment somebody links the commit, and only the URL is trusted afterwards.
 *
 * Linking is deliberately something a person does with their own GitHub account
 * attached: it records who says this commit belongs to this task.
 */

import { prisma } from "@polaris/db";
import { githubTokenForUser } from "@/lib/github-access";
import { listConnections } from "@/lib/connections/store";
// The same parser the repository field uses, so what counts as a GitHub
// repository is decided in exactly one place.
import { parseGithubCommit, type CommitReference } from "@/lib/repo-reference";

export interface CommitLink {
    readonly id: string;
    readonly repository: string;
    readonly sha: string;
    readonly shortSha: string;
    readonly message: string;
    readonly url: string;
    readonly authorName: string;
    readonly committedAt: string | null;
}

function shorten(sha: string): string {
    return sha.slice(0, 7);
}

function view(row: {
    id: string;
    repository: string;
    sha: string;
    message: string;
    url: string;
    authorName: string;
    committedAt: Date | null;
}): CommitLink {
    return {
        id: row.id,
        repository: row.repository,
        sha: row.sha,
        shortSha: shorten(row.sha),
        message: row.message,
        url: row.url,
        authorName: row.authorName,
        committedAt: row.committedAt?.toISOString() ?? null
    };
}

export async function listCommits(taskId: string): Promise<CommitLink[]> {
    const rows = await prisma.taskCommit.findMany({
        where: { taskId },
        orderBy: [{ committedAt: "desc" }, { createdAt: "desc" }],
        select: {
            id: true,
            repository: true,
            sha: true,
            message: true,
            url: true,
            authorName: true,
            committedAt: true
        }
    });
    return rows.map(view);
}

/** What GitHub says about one commit, asked as the person linking it, or nothing
 *  when their account cannot reach it. */
async function describeCommit(
    reference: CommitReference,
    userId: string
): Promise<{ message: string; authorName: string; committedAt: Date | null; sha: string } | null> {
    const token = await githubTokenForUser(userId, reference.owner);
    if (!token) return null;
    try {
        const response = await fetch(
            `https://api.github.com/repos/${reference.owner}/${reference.repo}/commits/${reference.sha}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28"
                },
                cache: "no-store"
            }
        );
        if (!response.ok) return null;
        const body = (await response.json()) as {
            sha?: string;
            commit?: { message?: string; author?: { name?: string; date?: string } };
        };
        const date = body.commit?.author?.date;
        return {
            // Only the first line: a commit body belongs in the commit, not on a
            // task row that has to stay scannable.
            message: (body.commit?.message ?? "").split("\n")[0]?.slice(0, 300) ?? "",
            authorName: body.commit?.author?.name ?? "",
            committedAt: date ? new Date(date) : null,
            sha: body.sha ?? reference.sha
        };
    } catch (error) {
        // A commit whose details cannot be fetched is still worth linking; the
        // link is the point, the message is decoration.
        console.error("tasks: could not read the commit from GitHub:", error);
        return null;
    }
}

export class CommitLinkError extends Error {}

/**
 * Attach a commit to a task.
 *
 * Refuses when the person has not linked their own GitHub account: a commit link
 * is a claim about who did what, and an unattributable claim is worth less than
 * no claim. It does NOT refuse when Polaris cannot reach GitHub - the link still
 * goes on, with whatever the URL itself carried.
 */
export async function linkCommit(taskId: string, userId: string, raw: string): Promise<CommitLink> {
    const [linkedAccount] = await listConnections(userId, "github");
    if (!linkedAccount) {
        throw new CommitLinkError("Connect your GitHub account under Connected accounts first");
    }

    const reference = parseGithubCommit(raw);
    if (!reference) {
        throw new CommitLinkError("Paste a commit link, or write it as owner/repo@sha");
    }

    const details = await describeCommit(reference, userId);
    const sha = details?.sha ?? reference.sha;
    const repository = `${reference.owner}/${reference.repo}`;

    const row = await prisma.taskCommit.upsert({
        where: { taskId_repository_sha: { taskId, repository, sha } },
        create: {
            taskId,
            repository,
            sha,
            message: details?.message ?? "",
            url: `https://github.com/${repository}/commit/${sha}`,
            authorName: details?.authorName ?? linkedAccount.label,
            committedAt: details?.committedAt ?? null,
            linkedById: userId
        },
        // Linking the same commit again refreshes what it says rather than
        // failing: the usual reason to do it is that the first attempt was made
        // before Polaris could reach GitHub.
        update: {
            message: details?.message ?? undefined,
            authorName: details?.authorName ?? undefined,
            committedAt: details?.committedAt ?? undefined
        },
        select: {
            id: true,
            repository: true,
            sha: true,
            message: true,
            url: true,
            authorName: true,
            committedAt: true
        }
    });
    return view(row);
}

export async function unlinkCommit(taskId: string, commitId: string): Promise<void> {
    await prisma.taskCommit.deleteMany({ where: { id: commitId, taskId } });
}
