/**
 * The print queue: every ticket printed once, none lost.
 *
 * A job is a row before it is a socket, so a restart or an update in the middle
 * of service loses nothing: the row is still "queued" and the next tick sends
 * it. A job is claimed with a conditional update (queued -> sending), so when
 * two dashboard processes overlap during an update only one of them sends it.
 * The caller's key is unique per printer, so a retried request finds the job it
 * already made instead of making a second one.
 *
 * Retries are safe only before the first byte leaves (see raw-socket.ts): an
 * unreachable printer, one out of paper or with its cover open is retried with
 * a growing wait for as long as RETRY_FOR_MS, then marked failed and kept for a
 * reprint. A job left in "sending" by a process that died, or one whose write
 * broke halfway, may already be on paper: it becomes "uncertain" and is never
 * resent without somebody asking for it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as socket from "./raw-socket";

/** Waiting jobs a printer may have before new ones are refused as busy. */
export const QUEUE_LIMIT = 200;
export const RETRY_FOR_MS = 30 * 60_000;
const TICK_MS = 3000;
const STALE_SENDING_MS = 2 * 60_000;

export type JobState = "queued" | "sending" | "printed" | "failed" | "uncertain";

export class QueueFullError extends Error {}

/** Wait before attempt `attempts + 1`: 2 s doubling to a minute. */
export function retryDelayMs(attempts: number): number {
    return Math.min(60_000, 2000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Queue a job, or find the one this key already made. Returns its id and
 * whether it is new; an existing job is never queued again, whatever its state.
 */
export async function enqueue(printerId: string, jobKey: string, payload: Uint8Array): Promise<{ id: string; created: boolean }> {
    const existing = await prisma.receiptPrintJob.findUnique({
        where: { printerId_jobKey: { printerId, jobKey } },
        select: { id: true }
    });
    if (existing) return { id: existing.id, created: false };
    const waiting = await prisma.receiptPrintJob.count({ where: { printerId, state: { in: ["queued", "sending"] } } });
    if (waiting >= QUEUE_LIMIT) throw new QueueFullError(`printer ${printerId} has ${waiting} jobs waiting`);
    try {
        const job = await prisma.receiptPrintJob.create({
            data: { printerId, jobKey, payload: Buffer.from(payload) },
            select: { id: true }
        });
        startQueue();
        void drain(printerId);
        return { id: job.id, created: true };
    } catch (error) {
        // Two requests with one key raced; the other one's row is the job.
        const raced = await prisma.receiptPrintJob.findUnique({ where: { printerId_jobKey: { printerId, jobKey } }, select: { id: true } });
        if (raced) return { id: raced.id, created: false };
        throw error;
    }
}

const draining = new Map<string, Promise<void>>();

/** Send what is due for one printer, one job at a time, oldest first. */
export function drain(printerId: string): Promise<void> {
    const running = draining.get(printerId);
    if (running) return running;
    const run = drainOnce(printerId).finally(() => draining.delete(printerId));
    draining.set(printerId, run);
    return run;
}

async function drainOnce(printerId: string): Promise<void> {
    for (;;) {
        const printer = await prisma.receiptPrinter.findUnique({ where: { id: printerId }, select: { address: true, port: true, transport: true } });
        if (!printer || printer.transport !== "lan") return;
        const job = await prisma.receiptPrintJob.findFirst({
            where: { printerId, state: "queued", nextAt: { lte: new Date() } },
            orderBy: { createdAt: "asc" },
            select: { id: true, payload: true, attempts: true, createdAt: true }
        });
        if (!job) return;
        const claimed = await prisma.receiptPrintJob.updateMany({
            where: { id: job.id, state: "queued" },
            data: { state: "sending", attempts: { increment: 1 }, nextAt: new Date() }
        });
        if (claimed.count !== 1) continue;
        const outcome = await socket.sendJob(printer.address, printer.port, new Uint8Array(job.payload));
        const now = new Date();
        if (outcome.kind === "printed") {
            await prisma.receiptPrintJob.update({ where: { id: job.id }, data: { state: "printed", printedAt: now, problem: null } });
            await prisma.receiptPrinter.update({ where: { id: printerId }, data: { problem: outcome.paperLow ? "paper-low" : null, checkedAt: now } });
            continue;
        }
        if (outcome.kind === "unknown") {
            await prisma.receiptPrintJob.update({ where: { id: job.id }, data: { state: "uncertain", problem: "interrupted" } });
            continue;
        }
        const expired = now.getTime() - job.createdAt.getTime() > RETRY_FOR_MS;
        await prisma.receiptPrintJob.update({
            where: { id: job.id },
            data: expired
                ? { state: "failed", problem: outcome.problem }
                : { state: "queued", problem: outcome.problem, nextAt: new Date(now.getTime() + retryDelayMs(job.attempts + 1)) }
        });
        await prisma.receiptPrinter.update({ where: { id: printerId }, data: { problem: outcome.problem, checkedAt: now } });
        // The printer is not taking jobs; the rest wait for the next tick.
        return;
    }
}

/** Mark jobs a dead process left mid-send as uncertain. */
export async function settleAbandoned(): Promise<number> {
    const result = await prisma.receiptPrintJob.updateMany({
        where: { state: "sending", nextAt: { lt: new Date(Date.now() - STALE_SENDING_MS) } },
        data: { state: "uncertain", problem: "interrupted" }
    });
    return result.count;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the tick that sends due jobs. Idempotent. */
export function startQueue(): void {
    if (timer) return;
    timer = setInterval(() => {
        void tick().catch((error) => console.error("polaris: receipt print queue tick failed:", error));
    }, TICK_MS);
    timer.unref?.();
}

async function tick(): Promise<void> {
    await settleAbandoned();
    const due = await prisma.receiptPrintJob.findMany({
        where: { state: "queued", nextAt: { lte: new Date() } },
        distinct: ["printerId"],
        select: { printerId: true },
        take: 100
    });
    await Promise.all(due.map((row) => drain(row.printerId)));
}

/** A job's state, for a caller waiting on its own print. */
export async function jobState(id: string): Promise<{ state: JobState; problem: string | null } | null> {
    const job = await prisma.receiptPrintJob.findUnique({ where: { id }, select: { state: true, problem: true } });
    return job ? { state: job.state as JobState, problem: job.problem } : null;
}

/** Put an uncertain or failed job back in the queue, when somebody asked for it. */
export async function reprint(id: string): Promise<boolean> {
    const result = await prisma.receiptPrintJob.updateMany({
        where: { id, state: { in: ["uncertain", "failed"] } },
        data: { state: "queued", nextAt: new Date(), problem: null, createdAt: new Date() }
    });
    if (result.count === 1) startQueue();
    return result.count === 1;
}
