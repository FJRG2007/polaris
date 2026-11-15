/**
 * The session board's columns: which one a session sits in, read from its
 * derived status (`session-status.ts`) and never stored.
 *
 * The lanes follow the work's own order - somebody has to answer, the agent is
 * at it, a pull request waits on review or checks, it came back with something
 * to fix, it can be merged, it is over - so a column is a question of whose
 * turn it is rather than a copy of the status list. Pure, so every mapping is
 * asserted in a test.
 */

import { z } from "zod";
import type * as status from "@/lib/agents/session-status";

export const BOARD_COLUMNS = ["needs_you", "working", "in_review", "fix_needed", "ready", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

const COLUMN_OF: Record<status.SessionStatus, BoardColumn> = {
    needs_input: "needs_you",
    // The agent finished its turn and nothing is open: the next word is a person's.
    idle: "needs_you",
    working: "working",
    // Started and silent: still the agent's turn until it says otherwise.
    no_signal: "working",
    pr_open: "in_review",
    review_pending: "in_review",
    draft: "in_review",
    ci_failed: "fix_needed",
    changes_requested: "fix_needed",
    commented: "fix_needed",
    merge_conflict: "fix_needed",
    approved: "ready",
    mergeable: "ready",
    merged: "done",
    terminated: "done",
    exited: "done"
};

/**
 * The column a session sits in. A pull request that would otherwise read as
 * ready while its checks are still running stays in review: "ready to merge"
 * is a promise the checks have not kept yet.
 */
export function boardColumnOf(
    derived: status.SessionStatus,
    prs: readonly Pick<status.PullFacts, "merged" | "closed" | "ci">[]
): BoardColumn {
    const column = COLUMN_OF[derived];
    if (column === "ready" && prs.some((pr) => !pr.merged && !pr.closed && pr.ci === "pending")) {
        return "in_review";
    }
    return column;
}

/** What one card says about a pull request's checks. */
export interface ChecksSummary {
    readonly total: number;
    readonly failed: number;
    readonly pending: number;
    readonly passed: number;
}

export function checksSummary(row: {
    checksTotal: number;
    checksFailed: number;
    checksPending: number;
}): ChecksSummary {
    const total = Math.max(0, row.checksTotal);
    const failed = Math.min(total, Math.max(0, row.checksFailed));
    const pending = Math.min(total - failed, Math.max(0, row.checksPending));
    return { total, failed, pending, passed: total - failed - pending };
}

/** The pull request a card names: the open one that decides the status, or
 *  else the newest. Null without one. */
export function cardPull<T extends { number: number; merged: boolean; closed: boolean }>(
    prs: readonly T[]
): T | null {
    if (prs.length === 0) return null;
    const open = prs.filter((pr) => !pr.merged && !pr.closed);
    const pool = open.length > 0 ? open : prs;
    return pool.reduce((best, pr) => (pr.number > best.number ? pr : best));
}

/** What the board is narrowed to: one repository, one agent, one person who
 *  started the session. Each is optional; none is every session in reach. */
export const BOARD_FILTERS = z
    .object({
        repo: z.string().uuid().optional(),
        agent: z
            .string()
            .trim()
            .regex(/^[a-z0-9-]{1,40}$/)
            .optional(),
        person: z.string().uuid().optional()
    })
    .strict();
export type BoardFilters = z.infer<typeof BOARD_FILTERS>;

/** The filters as the browser keeps them, read back without trusting them: a
 *  value from an older build or another hand reads as no filter. */
export function storedFilters(raw: string | null): BoardFilters {
    if (!raw) return {};
    try {
        const parsed = BOARD_FILTERS.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/** The query string the board route reads, with no empty values. */
export function filterQuery(filters: BoardFilters, done?: string | null): string {
    const params = new URLSearchParams();
    if (filters.repo) params.set("repo", filters.repo);
    if (filters.agent) params.set("agent", filters.agent);
    if (filters.person) params.set("person", filters.person);
    if (done) params.set("done", done);
    return params.toString();
}
