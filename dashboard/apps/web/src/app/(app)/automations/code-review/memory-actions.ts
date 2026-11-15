"use server";

/**
 * A person's own stored agent memory of a repository: seeing it and clearing
 * it. Always the signed-in person's, never anybody else's, so it needs no
 * permission beyond being signed in.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import * as store from "@/lib/agents/repo-memory-store";

const repoName = z.string().trim().min(3).max(200).refine(store.carriesMemory);

export async function repoMemoryAction(input: unknown): Promise<store.RepoMemorySummary | null> {
    const user = await requireUser();
    const parsed = repoName.safeParse(input);
    if (!parsed.success) return null;
    return store.repoMemorySummary(user.id, parsed.data);
}

export async function clearRepoMemoryAction(input: unknown): Promise<{ ok: boolean }> {
    const user = await requireUser();
    const parsed = repoName.safeParse(input);
    if (!parsed.success) return { ok: false };
    await store.clearRepoMemory(user.id, parsed.data);
    return { ok: true };
}
