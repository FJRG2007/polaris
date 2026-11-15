/**
 * Where a person's agent memory of a repository is stored between boxes. See
 * session-memory.ts for what is carried and why.
 */

import { prisma } from "@polaris/db";
import { memoryBytes, memoryKey, readStoredFiles, type MemoryFile } from "./session-memory";

/** Who and which repository a session's memory belongs to, or null for a
 *  session that carries none: a workspace, a server of somebody's own (whose
 *  home is already theirs), a machine everybody shares (whose home would hand
 *  one person's memory to the next), or one with no recorded starter. */
export async function sessionMemoryScope(
    sessionId: string
): Promise<{ userId: string; repoFullName: string } | null> {
    const record = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { startedById: true, place: true, sharedHome: true, repo: { select: { repoFullName: true } } }
    });
    if (!record?.startedById || !record.repo || record.place !== "local" || record.sharedHome) return null;
    return carriesMemory(record.repo.repoFullName) ? { userId: record.startedById, repoFullName: record.repo.repoFullName } : null;
}

/** Whether a repository name can carry memory at all. */
export function carriesMemory(repoFullName: string): boolean {
    return memoryKey(repoFullName) !== null;
}

function storedName(repoFullName: string): string {
    return repoFullName.trim().toLowerCase();
}

/** The stored files and when they were last written, or nothing. */
export async function loadRepoMemory(
    userId: string,
    repoFullName: string
): Promise<{ files: MemoryFile[]; updatedAt: Date | null }> {
    const row = await prisma.agentRepoMemory.findUnique({
        where: { userId_repoFullName: { userId, repoFullName: storedName(repoFullName) } },
        select: { files: true, updatedAt: true }
    });
    return row ? { files: readStoredFiles(row.files), updatedAt: row.updatedAt } : { files: [], updatedAt: null };
}

/** Replace the stored set with what the box holds now. An empty set removes
 *  the row: there is nothing left to carry. */
export async function saveRepoMemory(
    userId: string,
    repoFullName: string,
    files: readonly MemoryFile[]
): Promise<Date | null> {
    const name = storedName(repoFullName);
    if (files.length === 0) {
        await prisma.agentRepoMemory.deleteMany({ where: { userId, repoFullName: name } });
        return null;
    }
    const data = { files: files.map((file) => ({ path: file.path, data: file.data })), bytes: memoryBytes(files) };
    const row = await prisma.agentRepoMemory.upsert({
        where: { userId_repoFullName: { userId, repoFullName: name } },
        create: { userId, repoFullName: name, ...data },
        update: data,
        select: { updatedAt: true }
    });
    return row.updatedAt;
}

/** What a person sees of one repository's stored memory, without its contents. */
export interface RepoMemorySummary {
    readonly files: readonly { path: string; bytes: number }[];
    readonly bytes: number;
    readonly updatedAt: string | null;
}

export async function repoMemorySummary(userId: string, repoFullName: string): Promise<RepoMemorySummary> {
    const { files, updatedAt } = await loadRepoMemory(userId, repoFullName);
    return {
        files: files.map((file) => ({ path: file.path, bytes: memoryBytes([file]) })),
        bytes: memoryBytes(files),
        updatedAt: updatedAt?.toISOString() ?? null
    };
}

/** Forget a repository's stored memory. A box that still holds a copy drops it
 *  the next time a session of that repository boots there. */
export async function clearRepoMemory(userId: string, repoFullName: string): Promise<void> {
    await prisma.agentRepoMemory.deleteMany({ where: { userId, repoFullName: storedName(repoFullName) } });
}
