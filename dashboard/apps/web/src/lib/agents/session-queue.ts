/**
 * Sessions that wait for a free slot instead of being refused.
 *
 * Over either ceiling in `session-capacity`, a session is created `queued`: the
 * row, its branch and its first prompt exist, but no machine does. A sweep
 * starts queued sessions as slots free - first in, first out within one account,
 * and taking turns between accounts, so one person who queued twenty does not
 * hold everybody else behind them.
 *
 * Everything lives in the database, so a restart loses nothing: the next sweep
 * finds the same queue. A sweep claims each session with a conditional update
 * (`queued` -> `starting`) under an advisory lock, so two sweeps at once - the
 * timer and a Stop that just freed a slot - never start the same session twice
 * or overfill a ceiling between them.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";
import * as capacity from "@/lib/agents/session-capacity";

/** One queued session, as the planner needs it. */
export interface QueuedEntry {
    readonly id: string;
    readonly accountId: string;
    readonly queuedAt: Date;
}

/**
 * Which queued sessions to start now, in order.
 *
 * Pure, so the fairness can be asserted without a database. Accounts take turns:
 * each round gives one slot to every account that still has room and something
 * waiting, accounts ordered by how long their oldest entry has waited. Inside an
 * account the order is strictly the order things were queued.
 */
export function planQueue(
    queue: readonly QueuedEntry[],
    aliveByAccount: ReadonlyMap<string, number>,
    perAccount: number,
    freeTotal: number
): string[] {
    const byAccount = new Map<string, QueuedEntry[]>();
    for (const entry of [...queue].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())) {
        const list = byAccount.get(entry.accountId) ?? [];
        list.push(entry);
        byAccount.set(entry.accountId, list);
    }
    const alive = new Map(aliveByAccount);
    const picked: string[] = [];
    let free = Math.max(0, freeTotal);
    while (free > 0) {
        const round = [...byAccount.entries()]
            .filter(([account, list]) => list.length > 0 && (alive.get(account) ?? 0) < perAccount)
            .sort(([, a], [, b]) => a[0].queuedAt.getTime() - b[0].queuedAt.getTime());
        if (round.length === 0) break;
        for (const [account, list] of round) {
            if (free === 0) break;
            const next = list.shift();
            if (!next) continue;
            picked.push(next.id);
            alive.set(account, (alive.get(account) ?? 0) + 1);
            free -= 1;
        }
    }
    return picked;
}

/** Where a queued session stands: 1 is next. Counted within its own account,
 *  which is the order this person can actually reason about. */
export async function queuePosition(sessionId: string): Promise<number | null> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { state: true, startedById: true, createdAt: true }
    });
    if (!row || row.state !== "queued") return null;
    const ahead = await prisma.agentSession.count({
        where: { state: "queued", startedById: row.startedById, createdAt: { lt: row.createdAt } }
    });
    return ahead + 1;
}

/** How many sessions wait at most, per account. A queue is a promise to start
 *  something later, and an unbounded one is a promise nobody can keep. */
export const MAX_QUEUED_PER_ACCOUNT = 20;

/** The prompt a queued session was given, kept as its first message. */
async function firstPrompt(sessionId: string): Promise<string | null> {
    const message = await prisma.agentSessionMessage.findFirst({
        where: { sessionId, role: "user" },
        orderBy: { createdAt: "asc" },
        select: { body: true }
    });
    return message?.body ?? null;
}

/** Claim what fits, under one lock, and return the ids that are now ours. */
async function claim(): Promise<string[]> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            "SELECT pg_advisory_xact_lock(hashtext('polaris.agents.session-queue'))"
        );
        const queue = await tx.agentSession.findMany({
            where: { state: "queued" },
            orderBy: { createdAt: "asc" },
            select: { id: true, startedById: true, createdAt: true },
            take: 500
        });
        if (queue.length === 0) return [];
        const [perAccount, totalCeiling] = await Promise.all([
            capacity.perAccountCeiling(),
            capacity.totalCeiling()
        ]);
        const alive = await tx.agentSession.groupBy({
            by: ["startedById"],
            where: { state: { in: [...capacity.ALIVE_STATES] } },
            _count: { _all: true }
        });
        const aliveByAccount = new Map(
            alive.map((row) => [row.startedById ?? "", row._count._all] as const)
        );
        const total = alive.reduce((sum, row) => sum + row._count._all, 0);
        const planned = planQueue(
            queue.map((row) => ({
                id: row.id,
                accountId: row.startedById ?? "",
                queuedAt: row.createdAt
            })),
            aliveByAccount,
            perAccount,
            totalCeiling - total
        );
        const claimed: string[] = [];
        for (const id of planned) {
            const moved = await tx.agentSession.updateMany({
                where: { id, state: "queued" },
                data: { state: "starting" }
            });
            if (moved.count === 1) claimed.push(id);
        }
        return claimed;
    });
}

/**
 * Start what the ceilings now allow. Safe to call from anywhere and as often as
 * wanted: what one call claimed the next one does not see as queued.
 */
export async function sweepSessionQueue(): Promise<number> {
    const claimed = await claim();
    for (const id of claimed) {
        const reissued = await sessions.reissueSessionToken(id);
        if (!reissued) continue;
        try {
            await runtime.startSession(reissued.session, reissued.token);
        } catch {
            // startSession has already recorded the failure on the session.
            continue;
        }
        const prompt = await firstPrompt(id);
        if (prompt) void runtime.deliverFirstPrompt(id, prompt).catch(() => undefined);
    }
    return claimed.length;
}

/** What admitting a session came to. */
export interface Admission {
    readonly session: sessions.SessionView;
    /** Null when it started, otherwise where it stands in its account's queue. */
    readonly queuedAt: number | null;
    /** What stopped it starting, already recorded on the session. */
    readonly startError?: unknown;
}

/**
 * Create a session and start it, or queue it when a ceiling is full.
 *
 * The one way a session comes into being, from the screen, from MCP and from an
 * orchestration run alike, so no path can skip the ceiling again. The prompt is
 * recorded as the session's first message either way. A session that started
 * is handed it by the caller (`runtime.deliverFirstPrompt`); a queued one gets it
 * from the sweep once it has a terminal to type into.
 */
export async function admitSession(
    input: sessions.SessionCreateInput,
    prompt: string | null
): Promise<Admission> {
    const full = capacity.capacityRefusal(await capacity.sessionCapacity(input.startedById));
    if (full) {
        const waiting = await prisma.agentSession.count({
            where: { state: "queued", startedById: input.startedById }
        });
        if (waiting >= MAX_QUEUED_PER_ACCOUNT) {
            throw new sessions.SessionRefusal(
                `You already have ${waiting} sessions waiting to start, which is as many as one account may queue. Cancel one, or wait for one to start.`
            );
        }
        const { session } = await sessions.createSession({ ...input, queued: true });
        if (prompt) await sessions.addSessionMessage(session.id, "user", prompt, input.startedById);
        return { session, queuedAt: (await queuePosition(session.id)) ?? 1 };
    }
    const { session, token } = await sessions.createSession(input);
    try {
        await runtime.startSession(session, token);
    } catch (startError) {
        return { session, queuedAt: null, startError };
    }
    // Recorded here; delivered by the caller, inside `after()` where there is a
    // request, because the terminal is a clone and an install away.
    if (prompt) await sessions.addSessionMessage(session.id, "user", prompt, input.startedById);
    return { session, queuedAt: null };
}

/** Take a queued session out of the queue. False when it was no longer queued
 *  (it started in the meantime), so the caller stops it the ordinary way. */
export async function cancelQueued(sessionId: string): Promise<boolean> {
    const moved = await prisma.agentSession.updateMany({
        where: { id: sessionId, state: "queued" },
        data: {
            state: "stopped",
            tokenHash: null,
            finishedAt: new Date(),
            detail: "Cancelled before it started."
        }
    });
    return moved.count === 1;
}

/** Whether a state is one the queue owns, re-exported for screens. */
export const isQueued = core.isSessionQueued;
