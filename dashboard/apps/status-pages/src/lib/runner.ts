/**
 * The scheduled work: run the checks that are due, and prune what is old.
 *
 * Bounded on every side: at most `BATCH` checks a pass, `CONCURRENCY` at once,
 * each held to its own timeout (at most fifteen seconds), and no check runs more
 * often than every thirty seconds. Each run writes one sample, kept for a day,
 * and folds into its check's row for the day, which is what the bars read.
 *
 * Server-only.
 */

import { probe } from "./probe";
import { prisma } from "@polaris/db";
import { DAY_RETENTION_DAYS, SAMPLE_RETENTION_MS, dayStart } from "../model/uptime";
import { evaluate, nextRunAt, type CheckSpec, type CheckKind, type DnsType } from "../model/checks";

const BATCH = 100;
const CONCURRENCY = 8;

interface DueCheck {
    id: string;
    kind: string;
    target: string;
    port: number | null;
    expectStatus: number | null;
    keyword: string;
    dnsType: string | null;
    dnsExpect: string;
    intervalSec: number;
    timeoutMs: number;
}

export function specOf(row: DueCheck): CheckSpec {
    return {
        kind: row.kind as CheckKind,
        target: row.target,
        port: row.port,
        expectStatus: row.expectStatus,
        keyword: row.keyword,
        dnsType: (row.dnsType as DnsType | null) ?? null,
        dnsExpect: row.dnsExpect,
        timeoutMs: row.timeoutMs
    };
}

async function runOne(row: DueCheck): Promise<void> {
    const outcome = evaluate(specOf(row), await probe(specOf(row)));
    const at = new Date();
    const day = dayStart(at);
    await prisma.$transaction([
        prisma.statusCheck.update({
            where: { id: row.id },
            data: {
                nextRunAt: nextRunAt(at, row.intervalSec),
                lastStatus: outcome.ok ? "up" : "down",
                lastLatencyMs: outcome.latencyMs,
                lastError: outcome.error,
                lastCheckedAt: at
            }
        }),
        prisma.statusSample.create({
            data: { checkId: row.id, at, ok: outcome.ok, latencyMs: outcome.latencyMs }
        }),
        prisma.statusDay.upsert({
            where: { checkId_day: { checkId: row.id, day } },
            create: {
                checkId: row.id,
                day,
                total: 1,
                up: outcome.ok ? 1 : 0,
                latencySum: outcome.ok ? (outcome.latencyMs ?? 0) : 0
            },
            update: {
                total: { increment: 1 },
                up: { increment: outcome.ok ? 1 : 0 },
                latencySum: { increment: outcome.ok ? (outcome.latencyMs ?? 0) : 0 }
            }
        })
    ]);
}

/** Runs every check that is due, a bounded batch at a time. */
export async function runDueChecks(now = new Date()): Promise<number> {
    const due: DueCheck[] = await prisma.statusCheck.findMany({
        where: { enabled: true, nextRunAt: { lte: now } },
        orderBy: { nextRunAt: "asc" },
        take: BATCH,
        select: {
            id: true,
            kind: true,
            target: true,
            port: true,
            expectStatus: true,
            keyword: true,
            dnsType: true,
            dnsExpect: true,
            intervalSec: true,
            timeoutMs: true
        }
    });
    let next = 0;
    const worker = async () => {
        while (next < due.length) {
            const row = due[next++]!;
            try {
                await runOne(row);
            } catch (caught) {
                // A check deleted mid-run, or a database hiccup: the next pass
                // picks it up again, since nextRunAt did not move.
                console.warn(`[status-pages] check ${row.id} not recorded:`, (caught as Error).message);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
    return due.length;
}

/** Drops single results older than a day and daily rollups past the history. */
export async function pruneStatusHistory(now = new Date()): Promise<void> {
    await prisma.statusSample.deleteMany({
        where: { at: { lt: new Date(now.getTime() - SAMPLE_RETENTION_MS) } }
    });
    await prisma.statusDay.deleteMany({
        where: { day: { lt: new Date(dayStart(now).getTime() - DAY_RETENTION_DAYS * 86_400_000) } }
    });
}
