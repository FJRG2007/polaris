/**
 * The threads that check a password handed over in the clear against an
 * OPAQUE record (`passwordOpensHashlessAccount`). That check costs one
 * Argon2id of the record's profile, and on the event loop every request in
 * the process would wait for it; here it runs on a small pool of worker
 * threads, the server's counterpart of the browser's password Web Worker.
 *
 * The pool is bounded twice: SLOTS threads at most, each running one check at
 * a time, and WAITING_MOST checks queued behind them. A check that finds the
 * queue full, or that outlives RUN_MS, answers no - a burst of wrong
 * passwords costs the attacker a refusal, never the server its threads. The
 * threads start on first use, are kept for the next check (the OPAQUE module
 * is compiled once per thread) and never hold the process open.
 *
 * It also keeps what the checks recently cost, which is what `checkFloorMs`
 * reads: the time every failed password check is padded to, so the one that
 * ran this check takes as long as the one that did not.
 */

import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { CLEAR_PASSWORD_WORKER_SOURCE } from "./clear-password-worker";

/** Threads at once; each holds the profile's Argon2id memory while it runs. */
const SLOTS = Math.max(1, Math.min(2, Math.floor(availableParallelism() / 2)));
const WAITING_MOST = SLOTS * 16;
/** A check past this answers no and its thread is replaced. */
const RUN_MS = 10_000;
/** The floor never drops below this, nor rises above the ceiling, whatever the checks cost. */
const FLOOR_LEAST_MS = 250;
const FLOOR_MOST_MS = 3_000;
/** How many recent checks the floor is read from, and how far above the slowest it sits. */
const RECENT = 16;
const FLOOR_MARGIN = 1.5;

export interface ClearPasswordJob {
    readonly serverSetup: string;
    readonly userId: string;
    readonly record: string;
    readonly password: string;
    /** The record's key-stretching profile, as `passwordKsf` spells it. */
    readonly keyStretching: unknown;
}

interface Slot {
    worker: Worker | null;
    pending: { id: number; settle: (opens: boolean) => void; timer: ReturnType<typeof setTimeout> } | null;
}

const slots: Slot[] = Array.from({ length: SLOTS }, () => ({ worker: null, pending: null }));
const waiting: { job: ClearPasswordJob; settle: (opens: boolean) => void }[] = [];
const recent: number[] = [];
let nextId = 1;
let opaquePath: string | null = null;

function opaqueModule(): string {
    opaquePath ??= createRequire(join(process.cwd(), "package.json")).resolve("@serenity-kit/opaque");
    return opaquePath;
}

/** Ends whatever the slot was running with a no and forgets its thread. */
function drop(slot: Slot): void {
    const worker = slot.worker;
    slot.worker = null;
    const pending = slot.pending;
    slot.pending = null;
    if (pending) {
        clearTimeout(pending.timer);
        pending.settle(false);
    }
    if (worker) void worker.terminate().catch(() => undefined);
}

function threadFor(slot: Slot): Worker {
    if (slot.worker) return slot.worker;
    const worker = new Worker(CLEAR_PASSWORD_WORKER_SOURCE, {
        eval: true,
        env: {},
        argv: [],
        execArgv: [],
        stdout: true,
        stderr: true,
        workerData: { opaque: opaqueModule() },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }
    });
    worker.unref();
    worker.on("message", (message: { id?: unknown; opens?: unknown } | null) => {
        const pending = slot.pending;
        if (slot.worker !== worker || !pending || message?.id !== pending.id) return;
        clearTimeout(pending.timer);
        slot.pending = null;
        pending.settle(message.opens === true);
        next();
    });
    const lost = (cause: unknown) => {
        if (slot.worker !== worker) return;
        console.error("polaris: a password check thread stopped:", cause);
        drop(slot);
        next();
    };
    worker.on("error", lost);
    worker.on("exit", (code) => lost(`exit ${code}`));
    slot.worker = worker;
    return worker;
}

/** Hands the next queued check to a free slot, if there is one. */
function next(): void {
    for (const slot of slots) {
        if (slot.pending) continue;
        const queued = waiting.shift();
        if (!queued) return;
        start(slot, queued.job, queued.settle);
    }
}

function start(slot: Slot, job: ClearPasswordJob, settle: (opens: boolean) => void): void {
    let worker: Worker;
    try {
        worker = threadFor(slot);
    } catch (caught) {
        console.error("polaris: a password check thread could not start:", caught);
        settle(false);
        return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
        console.error("polaris: a password check ran past its time and was stopped");
        drop(slot);
        next();
    }, RUN_MS);
    timer.unref?.();
    slot.pending = { id, settle, timer };
    worker.postMessage({ id, ...job });
}

/**
 * Whether `job.password` opens `job.record`, checked on a pool thread. Never
 * throws: a full queue, a thread that fails or one that runs too long is a no.
 */
export function passwordOpensRecordOffThread(job: ClearPasswordJob): Promise<boolean> {
    const began = Date.now();
    return new Promise<boolean>((resolve) => {
        const settle = (opens: boolean) => {
            remember(Date.now() - began);
            resolve(opens);
        };
        const free = slots.find((slot) => !slot.pending);
        if (free) return start(free, job, settle);
        if (waiting.length >= WAITING_MOST) {
            console.error("polaris: too many password checks are waiting; this one was refused");
            return resolve(false);
        }
        waiting.push({ job, settle });
    });
}

function remember(ms: number): void {
    recent.push(ms);
    if (recent.length > RECENT) recent.shift();
}

/**
 * How long a failed password check takes at least: well above what the
 * recent checks on this pool cost (queueing included, so a busy server raises
 * it for every account alike), within fixed bounds.
 */
export function checkFloorMs(): number {
    const slowest = recent.length > 0 ? Math.max(...recent) : 0;
    return Math.min(FLOOR_MOST_MS, Math.max(FLOOR_LEAST_MS, Math.ceil(slowest * FLOOR_MARGIN)));
}
