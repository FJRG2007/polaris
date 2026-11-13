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

import { z } from "zod";
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

/** The Code sessions that match the words typed, every word somewhere in the
 *  title or the repository. */
export function filterCodeRows<T extends Pick<PolarCodeRow, "title" | "repo">>(
    rows: readonly T[],
    query: string
): T[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [...rows];
    return rows.filter((row) => {
        const text = `${row.title} ${row.repo}`.toLowerCase();
        return words.every((word) => text.includes(word));
    });
}

/** The session "/stop" stops the turn of. */
export const polarCodeInterruptSchema = z.object({ sessionId: z.string().trim().uuid() }).strict();

/** A change to one row of the Code history, as the sidebar sends it. */
export const polarCodeEditSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("delete"), sessionId: z.string().trim().uuid() }).strict(),
    z
        .object({
            action: z.literal("rename"),
            sessionId: z.string().trim().uuid(),
            title: z.string().trim().min(1).max(80)
        })
        .strict()
]);

/** As many lines of activity as the thread shows; the session's own page keeps
 *  the rest. */
const EVENTS_SHOWN = 80;

/** Events that only mark a reply as over. The answer itself says that, so a
 *  line for it is noise; a failed turn, a stop or a question still shows. */
const QUIET_EVENTS = new Set(["turn.end"]);

/** The events a thread draws, newest last and bounded. */
export function threadEvents<T extends { kind: string }>(events: readonly T[]): T[] {
    return events.filter((event) => !QUIET_EVENTS.has(event.kind)).slice(-EVENTS_SHOWN);
}
