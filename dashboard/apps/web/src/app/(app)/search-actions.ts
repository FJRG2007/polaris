"use server";

/**
 * The account's search history, as the palette reads and writes it.
 *
 * Kept beside the mention actions rather than inside an app, for the same
 * reason: the search field is on every screen, so its writes belong to the shell
 * that carries it. Nothing here is revalidated - the history is drawn by one
 * client component that already has the answer it just wrote.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { requireUser } from "@/lib/session";
import * as history from "@/lib/search/history-service";

export async function listRecentSearchesAction(): Promise<{ recent: core.RecentSearch[] }> {
    const user = await requireUser();
    try {
        return { recent: await history.listRecentSearches(user.id) };
    } catch (caught) {
        // A history that cannot be read is not worth failing an open panel over.
        console.error(caught);
        return { recent: [] };
    }
}

export async function recordSearchAction(input: unknown): Promise<void> {
    const parsed = core.recentSearchSchema.safeParse(input);
    if (!parsed.success) return;

    const user = await requireUser();
    try {
        await history.recordSearch(user.id, parsed.data);
    } catch (caught) {
        console.error(caught);
    }
}

const forgetInput = z.object({ key: z.string().min(1).max(700) });

export async function forgetSearchAction(input: unknown): Promise<void> {
    const parsed = forgetInput.safeParse(input);
    if (!parsed.success) return;

    const user = await requireUser();
    try {
        await history.forgetSearch(user.id, parsed.data.key);
    } catch (caught) {
        console.error(caught);
    }
}

export async function clearSearchHistoryAction(): Promise<void> {
    const user = await requireUser();
    try {
        await history.clearSearchHistory(user.id);
    } catch (caught) {
        console.error(caught);
    }
}
