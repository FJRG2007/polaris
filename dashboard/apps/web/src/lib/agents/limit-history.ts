/**
 * The usage limits a person's Code sessions ran into, and what each session
 * spent, for the Usage page of Polar's settings.
 *
 * A hit is written where the session moves on from it (`account-rotation.ts`)
 * and kept 30 days; a person's own older hits are cleared as a new one lands,
 * so the table holds a bounded window per person rather than growing forever.
 *
 * Ported from Agent Orchestrator (Apache-2.0),
 * backend/internal/service/usage/limit_history.go (limit history view).
 */

import { prisma } from "@polaris/db";

const DAY = 86_400_000;

/** How long a hit is kept. */
export const LIMIT_HIT_DAYS = 30;

/** How far back the screen looks, and how much it lists. */
export const LIMIT_HISTORY_DAYS = 14;
export const LIMIT_HISTORY_ROWS = 50;

export type LimitOutcome = "rotated" | "waiting";

export interface LimitHit {
    readonly userId: string;
    readonly sessionId: string;
    readonly cli: string;
    readonly accountId: string | null;
    readonly resetAt: number | null;
    readonly outcome: LimitOutcome;
}

/** Record one hit. Best effort: a session is never held up by its history. */
export async function noteLimitHit(hit: LimitHit, now = Date.now()): Promise<void> {
    try {
        await prisma.agentLimitHit.create({
            data: {
                userId: hit.userId,
                sessionId: hit.sessionId,
                cli: hit.cli,
                accountId: hit.accountId,
                resetAt: hit.resetAt === null ? null : new Date(hit.resetAt),
                outcome: hit.outcome
            },
            select: { id: true }
        });
        await prisma.agentLimitHit.deleteMany({
            where: { userId: hit.userId, createdAt: { lt: new Date(now - LIMIT_HIT_DAYS * DAY) } }
        });
    } catch (error) {
        console.error(
            "[agent-session] could not record a usage limit:",
            error instanceof Error ? error.message : "unknown"
        );
    }
}

export interface CodeUsage {
    /** This calendar month's sessions, per agent, most spent first. */
    readonly byAgent: ReadonlyArray<{
        cli: string;
        sessions: number;
        tokens: number;
        costUsd: number | null;
    }>;
    readonly limits: ReadonlyArray<{
        id: string;
        sessionId: string;
        cli: string;
        outcome: LimitOutcome;
        resetAt: string | null;
        at: string;
    }>;
}

/** The first moment of the month `now` is in, in UTC. Pure. */
export function monthStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** What this person's Code sessions spent this month and the limits they hit. */
export async function codeUsageFor(userId: string, now = new Date()): Promise<CodeUsage> {
    const [groups, hits] = await Promise.all([
        prisma.agentSession.groupBy({
            by: ["cli"],
            where: { startedById: userId, createdAt: { gte: monthStart(now) } },
            _count: { _all: true },
            _sum: { tokensIn: true, tokensOut: true, costUsd: true }
        }),
        prisma.agentLimitHit.findMany({
            where: { userId, createdAt: { gte: new Date(now.getTime() - LIMIT_HISTORY_DAYS * DAY) } },
            select: { id: true, sessionId: true, cli: true, outcome: true, resetAt: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: LIMIT_HISTORY_ROWS
        })
    ]);
    return {
        byAgent: groups
            .map((group) => ({
                cli: group.cli,
                sessions: group._count._all,
                tokens: (group._sum.tokensIn ?? 0) + (group._sum.tokensOut ?? 0),
                costUsd: group._sum.costUsd ?? null
            }))
            .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens),
        limits: hits.map((hit) => ({
            id: hit.id,
            sessionId: hit.sessionId,
            cli: hit.cli,
            outcome: hit.outcome === "waiting" ? "waiting" : "rotated",
            resetAt: hit.resetAt?.toISOString() ?? null,
            at: hit.createdAt.toISOString()
        }))
    };
}
