/**
 * Polar's Code history: the person's own sessions as the sidebar lists them,
 * beside their chats.
 *
 * Starting the same task again - after a failed start, a stop, a retry - leaves
 * a row per attempt, and a history that repeats one task five times hides the
 * others. So a task is listed once, by its newest session; the Agents page
 * keeps every attempt. A session still running is never merged away: it is
 * the one that can still be told something. Pure, so the server's page and
 * the browser's merge of several pages agree on what one task is.
 */

import type { PolarCodeRow } from "@/lib/polar/code";

type HistoryRow = Pick<PolarCodeRow, "id" | "title" | "repo" | "branch" | "live" | "createdAt">;

/** Sessions to a page of the history. */
export const POLAR_CODE_PAGE = 20;

/** What makes two sessions the same task: the same words, in the same place. */
export function codeTaskKey(row: Pick<HistoryRow, "title" | "repo" | "branch">): string {
    const title = row.title.trim().replace(/\s+/g, " ").toLowerCase();
    return `${row.repo.trim().toLowerCase()}\n${row.branch.trim()}\n${title}`;
}

function newestFirst(a: HistoryRow, b: HistoryRow): number {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Newest first, each session once and each task once: every live session of
 *  it, or else its newest one. Of two copies of one session, the one earlier
 *  in `rows` wins. */
export function dedupeCodeRows<T extends HistoryRow>(rows: readonly T[]): T[] {
    const ids = new Set<string>();
    const unique = rows.filter((row) => !ids.has(row.id) && Boolean(ids.add(row.id)));
    const tasks = new Set(unique.filter((row) => row.live).map(codeTaskKey));
    return [...unique].sort(newestFirst).filter((row) => {
        if (row.live) return true;
        const key = codeTaskKey(row);
        if (tasks.has(key)) return false;
        tasks.add(key);
        return true;
    });
}

/** A fresh page over the rows already listed: a session the server sent again
 *  wins, the pages read before stay. */
export function mergeCodeRows<T extends HistoryRow>(
    current: readonly T[] | null,
    fresh: readonly T[]
): T[] {
    return dedupeCodeRows([...fresh, ...(current ?? [])]);
}
