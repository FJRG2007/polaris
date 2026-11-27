/**
 * One person's Polar spend over a window, for the Usage page: tokens per day,
 * per model and per chat, and the cost worked out from the catalogue's prices
 * where it has one. The layout follows the provider consoles (Anthropic's and
 * OpenAI's usage pages, OpenRouter's activity): a daily chart over a period,
 * then the same period split by model and by what spent it.
 *
 * Every read is bounded by the person and the window on the `[userId,
 * createdAt]` index, summed in the database; the chats are cut to the busiest.
 */

import { Prisma, prisma } from "@polaris/db";
import type { Payer } from "@/lib/polar/shared";

export const POLAR_USAGE_RANGES = ["7d", "30d", "90d"] as const;
export type PolarUsageRange = (typeof POLAR_USAGE_RANGES)[number];

const RANGE_DAYS: Record<PolarUsageRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
const DAY_MS = 86_400_000;
/** How many chats the report names; the rest are only in the totals. */
export const REPORT_CHATS = 20;

export interface PolarUsageTotals {
    answers: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    /** The priced answers' cost; `unpriced` counts the answers left out. */
    costUsd: number;
    unpriced: number;
}

export interface PolarUsageDay {
    /** The day's start, UTC, in milliseconds. */
    t: number;
    answers: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export interface PolarUsageModel extends PolarUsageTotals {
    provider: string;
    model: string;
    payer: Payer;
}

export interface PolarUsageChat {
    threadId: string;
    /** Null for a chat since deleted: what it spent still counts. */
    title: string | null;
    answers: number;
    tokens: number;
    costUsd: number;
}

export interface PolarUsageReport {
    range: PolarUsageRange;
    from: number;
    to: number;
    totals: PolarUsageTotals;
    days: PolarUsageDay[];
    models: PolarUsageModel[];
    chats: PolarUsageChat[];
}

interface DayRow {
    day: Date;
    answers: bigint | number;
    input: bigint | number | null;
    output: bigint | number | null;
    cost: number | null;
}

/** The window's days, oldest first, the last one today (UTC). Pure. */
export function windowDays(range: PolarUsageRange, now: Date): { from: number; to: number } {
    const to = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
    return { from: to - (RANGE_DAYS[range] - 1) * DAY_MS, to };
}

/** Per-day sums folded into every day of the window, a quiet day a zero. Pure. */
export function foldDays(rows: readonly DayRow[], from: number, to: number): PolarUsageDay[] {
    const days: PolarUsageDay[] = [];
    for (let t = from; t <= to; t += DAY_MS)
        days.push({ t, answers: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    for (const row of rows) {
        const day = days[Math.floor((row.day.getTime() - from) / DAY_MS)];
        if (!day) continue;
        day.answers += Number(row.answers);
        day.inputTokens += Number(row.input ?? 0);
        day.outputTokens += Number(row.output ?? 0);
        day.costUsd += row.cost ?? 0;
    }
    return days;
}

const keyOf = (row: { provider: string; model: string; payer: string }) =>
    `${row.provider}\u0000${row.model}\u0000${row.payer}`;

export async function polarUsageReport(
    userId: string,
    range: PolarUsageRange,
    now = new Date()
): Promise<PolarUsageReport> {
    const { from, to } = windowDays(range, now);
    const where = { userId, createdAt: { gte: new Date(from) } };
    const [dayRows, models, unpriced, chats] = await Promise.all([
        prisma.$queryRaw<DayRow[]>(Prisma.sql`
            SELECT date_trunc('day', u."createdAt") AS day,
                   count(*) AS answers,
                   sum(u."inputTokens") AS input,
                   sum(u."outputTokens") AS output,
                   sum(u."costUsd") AS cost
            FROM "PolarUsage" u
            WHERE u."userId" = ${userId}::uuid AND u."createdAt" >= ${new Date(from)}
            GROUP BY 1
        `),
        prisma.polarUsage.groupBy({
            by: ["provider", "model", "payer"],
            where,
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, cachedTokens: true, costUsd: true }
        }),
        prisma.polarUsage.groupBy({
            by: ["provider", "model", "payer"],
            where: { ...where, costUsd: null },
            _count: { _all: true }
        }),
        prisma.polarUsage.groupBy({
            by: ["threadId"],
            where: { ...where, threadId: { not: null } },
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, costUsd: true },
            orderBy: { _sum: { inputTokens: "desc" } },
            take: REPORT_CHATS
        })
    ]);

    const ids = chats.flatMap((row) => (row.threadId ? [row.threadId] : []));
    const threads = ids.length
        ? await prisma.polarThread.findMany({
              where: { id: { in: ids }, userId },
              select: { id: true, title: true }
          })
        : [];
    const titles = new Map(threads.map((thread) => [thread.id, thread.title]));

    const missing = new Map(unpriced.map((row) => [keyOf(row), row._count._all]));
    const modelRows = models
        .map(
            (row): PolarUsageModel => ({
                provider: row.provider,
                model: row.model,
                payer: row.payer as Payer,
                answers: row._count._all,
                inputTokens: row._sum.inputTokens ?? 0,
                outputTokens: row._sum.outputTokens ?? 0,
                cachedTokens: row._sum.cachedTokens ?? 0,
                costUsd: row._sum.costUsd ?? 0,
                unpriced: missing.get(keyOf(row)) ?? 0
            })
        )
        .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

    const totals: PolarUsageTotals = {
        answers: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        unpriced: 0
    };
    for (const row of modelRows) {
        totals.answers += row.answers;
        totals.inputTokens += row.inputTokens;
        totals.outputTokens += row.outputTokens;
        totals.cachedTokens += row.cachedTokens;
        totals.costUsd += row.costUsd;
        totals.unpriced += row.unpriced;
    }

    return {
        range,
        from,
        to,
        totals,
        days: foldDays(dayRows, from, to),
        models: modelRows,
        chats: chats.map((row) => ({
            threadId: row.threadId!,
            title: titles.get(row.threadId!) ?? null,
            answers: row._count._all,
            tokens: (row._sum.inputTokens ?? 0) + (row._sum.outputTokens ?? 0),
            costUsd: row._sum.costUsd ?? 0
        }))
    };
}
