/**
 * The durable engine: starting runs, stepping them, waiting, ending them.
 *
 * Every state change is a row write and nothing lives only in memory, so a
 * process that dies part-way - an Update replacing the container - leaves rows
 * the next pass picks up:
 *
 * - A run is stepped only by the process holding its lease (`lockedUntil` +
 *   `lockToken`, compare-and-swap like `lib/cron/lease.ts`). A dead holder's
 *   lease expires and another process takes it.
 * - A step is marked `running` before its node does anything and `ok` after,
 *   both by conditional update. A step found `running` under a fresh lease was
 *   cut off: an idempotent node runs again, any other is `interrupted` and
 *   follows its "if this fails" rule - an HTTP POST is never silently sent twice.
 * - A step row is unique per (run, node, iteration, attempt), so enqueuing the
 *   same successor twice writes one row.
 * - A run's firing key is unique per automation, so the same event or due time
 *   processed twice starts one run.
 *
 * Waiting runs hold nothing: their due time is a column the job reads.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { isUuid } from "@/lib/uuid";
import { randomBytes } from "node:crypto";
import { automationRunner, mayAllowLocalNetwork } from "./runner";
import { serverNode } from "./node-registry";
import { readSecretForRun } from "./secrets";
import {
    StepError,
    StepRefusal,
    type NodeIo,
    type NodeResult,
    type RunContext,
    type StopAs
} from "./types";

const L = core.AUTOMATION_LIMITS;
const MAIN = core.MAIN_ITERATION;
const FINALLY = core.FINALLY_ITERATION;

let stopping = false;

/** Stop taking new work: in-flight steps finish, nothing new is claimed. Called on SIGTERM. */
export function stopClaiming(): void {
    stopping = true;
}

/** For tests: start claiming again. */
export function resumeClaiming(): void {
    stopping = false;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Versions are immutable, so a parsed graph is cached by id. Bounded. */
const graphs = new Map<string, core.AutomationGraph>();
const GRAPH_CACHE = 200;

export async function loadGraph(versionId: string): Promise<core.AutomationGraph | null> {
    const cached = graphs.get(versionId);
    if (cached) return cached;
    const version = await prisma.automationVersion.findUnique({
        where: { id: versionId },
        select: { graph: true }
    });
    if (!version) return null;
    const parsed = core.automationGraphSchema.safeParse(version.graph);
    if (!parsed.success) return null;
    if (graphs.size >= GRAPH_CACHE) graphs.delete(graphs.keys().next().value!);
    graphs.set(versionId, parsed.data);
    return parsed.data;
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export interface Firing {
    readonly automationId: string;
    readonly versionId: string;
    readonly triggerNodeId: string;
    readonly firingKey: string;
    readonly cause: Record<string, unknown>;
    readonly depth: number;
    /** A run started by a "Run another automation" step: the caller, and the step that waits. */
    readonly parentRunId?: string;
    readonly parentStepId?: string;
    /** A test run of the draft from the editor: never held back by the mode or the rate limit, never counted against them. */
    readonly test?: boolean;
}

export interface StartedRun {
    readonly id: string;
    readonly status: string;
}

function uniqueViolation(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === "P2002";
}

/**
 * Start (or queue, skip, hold back) one run for a firing, by the automation's
 * mode and rate limit. Idempotent on the firing key.
 *
 * Callers serialise admission across processes through the intake lease
 * (`outbox.ts`), so "single" means single.
 */
export async function startRun(firing: Firing): Promise<StartedRun | null> {
    const automation = await prisma.automation.findUnique({
        where: { id: firing.automationId },
        select: { id: true, mode: true, maxRuns: true, rateLimit: true }
    });
    if (!automation) return null;
    const existing = await prisma.automationRun.findFirst({
        where: { automationId: firing.automationId, firingKey: firing.firingKey },
        select: { id: true, status: true }
    });
    if (existing) return existing;

    const now = new Date();
    const mode = (core.AUTOMATION_MODES as readonly string[]).includes(automation.mode)
        ? (automation.mode as core.AutomationMode)
        : core.DEFAULT_AUTOMATION_MODE;
    const [active, queued, recent] = await Promise.all([
        prisma.automationRun.count({
            where: {
                automationId: automation.id,
                test: false,
                status: { in: [...core.ACTIVE_RUN_STATUSES] }
            }
        }),
        prisma.automationRun.count({
            where: { automationId: automation.id, test: false, status: "queued" }
        }),
        prisma.automationRun.count({
            where: {
                automationId: automation.id,
                test: false,
                queuedAt: { gte: new Date(now.getTime() - core.RATE_WINDOW_MS) },
                status: { notIn: ["skipped", "limited", "refused"] }
            }
        })
    ]);
    const admission: core.Admission = firing.test
        ? "start"
        : firing.depth > L.depth
          ? "skip"
          : core.admitRun({
                mode,
                maxRuns: automation.maxRuns,
                rateLimit: automation.rateLimit,
                active,
                queued,
                recent
            });

    const status =
        firing.depth > L.depth
            ? "refused"
            : admission === "start" || admission === "restart"
              ? "running"
              : admission === "queue"
                ? "queued"
                : admission === "limit"
                  ? "limited"
                  : "skipped";
    const error =
        firing.depth > L.depth
            ? "loop"
            : admission === "skip"
              ? mode === "single"
                  ? "alreadyRunning"
                  : "queueFull"
              : admission === "limit"
                ? "rateLimited"
                : null;
    const finished = core.runFinished(status);

    let run: StartedRun;
    try {
        run = await prisma.automationRun.create({
            data: {
                automationId: firing.automationId,
                versionId: firing.versionId,
                status,
                triggerNodeId: firing.triggerNodeId,
                cause: capCause(firing.cause) as object,
                firingKey: firing.firingKey,
                depth: firing.depth,
                test: firing.test ?? false,
                parentRunId: firing.parentRunId ?? null,
                parentStepId: firing.parentStepId ?? null,
                error,
                queuedAt: now,
                startedAt: status === "running" ? now : null,
                finishedAt: finished ? now : null
            },
            select: { id: true, status: true }
        });
    } catch (caught) {
        if (!uniqueViolation(caught)) throw caught;
        return prisma.automationRun.findFirst({
            where: { automationId: firing.automationId, firingKey: firing.firingKey },
            select: { id: true, status: true }
        });
    }

    if (admission === "restart") {
        const others = await prisma.automationRun.findMany({
            where: {
                automationId: automation.id,
                status: { in: [...core.ACTIVE_RUN_STATUSES] },
                id: { not: run.id }
            },
            select: { id: true },
            take: L.maxRunsCeiling
        });
        for (const other of others) await cancelRun(other.id, "restarted");
    }
    if (status === "running") await beginRun(run.id, firing);
    if (firing.test) return run;
    await prisma.automation.update({
        where: { id: automation.id },
        data: { lastRunAt: now, lastStatus: status }
    });
    return run;
}

function capCause(cause: Record<string, unknown>): Record<string, unknown> {
    const capped = core.capStored(cause, L.eventPayloadBytes);
    return (capped && typeof capped === "object" ? capped : {}) as Record<string, unknown>;
}

/** Write the trigger's own step (it already happened) and make its successors ready. */
async function beginRun(
    runId: string,
    firing: Pick<Firing, "versionId" | "triggerNodeId" | "cause">
): Promise<void> {
    const graph = await loadGraph(firing.versionId);
    const now = new Date();
    await prisma.automationStep.createMany({
        data: [
            {
                runId,
                nodeId: firing.triggerNodeId,
                iteration: MAIN,
                status: "ok",
                port: "next",
                output: capCause(firing.cause) as object,
                startedAt: now,
                finishedAt: now
            }
        ],
        skipDuplicates: true
    });
    if (!graph) return;
    await enqueue(runId, core.successors(graph, firing.triggerNodeId, "next"), MAIN);
}

async function enqueue(
    runId: string,
    nodeIds: readonly string[],
    iteration: string
): Promise<void> {
    if (nodeIds.length === 0) return;
    await prisma.automationStep.createMany({
        data: [...new Set(nodeIds)].map((nodeId) => ({
            runId,
            nodeId,
            iteration,
            status: "ready"
        })),
        skipDuplicates: true
    });
}

/** Start the oldest queued run of an automation once nothing is active. */
async function promoteQueued(automationId: string): Promise<string | null> {
    const active = await prisma.automationRun.count({
        where: { automationId, status: { in: [...core.ACTIVE_RUN_STATUSES] } }
    });
    if (active > 0) return null;
    const next = await prisma.automationRun.findFirst({
        where: { automationId, status: "queued" },
        orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
        select: { id: true, versionId: true, triggerNodeId: true, cause: true }
    });
    if (!next) return null;
    const won = await prisma.automationRun.updateMany({
        where: { id: next.id, status: "queued" },
        data: { status: "running", startedAt: new Date() }
    });
    if (won.count !== 1) return null;
    await beginRun(next.id, { ...next, cause: (next.cause ?? {}) as Record<string, unknown> });
    return next.id;
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

/**
 * Stop a run. Its Finally lane runs only when the automation ticked "also when
 * cancelled": a cancel is a decision to stop doing things.
 */
export async function cancelRun(runId: string, reason = "cancelled"): Promise<boolean> {
    const run = await prisma.automationRun.findUnique({
        where: { id: runId },
        select: { id: true, status: true, versionId: true, finally: true, automationId: true }
    });
    if (!run || core.runFinished(run.status)) return false;
    await prisma.automationStep.updateMany({
        where: {
            runId,
            iteration: { startsWith: MAIN },
            status: { in: ["ready", "waiting", "running"] }
        },
        data: { status: "skipped", finishedAt: new Date() }
    });
    const graph = await loadGraph(run.versionId);
    await cancelChildren(runId);
    if (
        graph?.finally.entry &&
        graph.finally.onCancel &&
        run.finally === "none" &&
        run.status !== "queued"
    ) {
        const moved = await prisma.automationRun.updateMany({
            where: { id: runId, finally: "none" },
            data: {
                status: "running",
                outcome: "cancelled",
                finally: "pending",
                error: reason,
                dueAt: null
            }
        });
        if (moved.count === 1) await enqueue(runId, [graph.finally.entry], FINALLY);
        return true;
    }
    await prisma.automationRun.updateMany({
        where: { id: runId, status: { notIn: [...core.FINISHED_RUN_STATUSES] } },
        data: {
            status: "cancelled",
            error: reason,
            finishedAt: new Date(),
            lockedUntil: null,
            lockToken: null
        }
    });
    await prisma.automationStep.updateMany({
        where: { runId, iteration: { startsWith: FINALLY }, status: { in: ["ready", "waiting"] } },
        data: { status: "skipped", finishedAt: new Date() }
    });
    await cancelChildren(runId);
    await resumeParent(runId);
    await announceFinished(runId, "cancelled", reason);
    await promoteQueued(run.automationId);
    return true;
}

// ---------------------------------------------------------------------------
// Iterations
// ---------------------------------------------------------------------------

/**
 * A step's iteration is its lane ("0" main, "f" Finally) followed by one
 * `/<loopId>:<pass>` segment per loop it runs inside, so every pass of a loop
 * body has rows of its own and a pass can never collide with another.
 */
const SEPARATOR = "/";

/** The wait key of a step waiting for the run it called. */
const CALL_WAIT = "run:";

export function laneOf(iteration: string): string {
    return iteration.split(SEPARATOR)[0]!;
}

function passIteration(iteration: string, loopId: string, pass: number): string {
    return `${iteration}${SEPARATOR}${loopId}:${pass}`;
}

/** The wait key of a Try waiting for its body. */
const TRY_WAIT = "try";
/** Set on a failed Try once its failure has gone on to the scope around it. */
const RETHROWN = "rethrown";

/**
 * A Try body's iteration: a segment with no pass number, so it never reads as a
 * loop pass (an item, an index, a pass shown on the run).
 */
function tryIteration(iteration: string, tryId: string): string {
    return `${iteration}${SEPARATOR}${tryId}${TRY_SEGMENT}`;
}

const TRY_SEGMENT = ":try";

/** The scope an iteration reads as once the Try bodies it ends in are seen through. */
function outsideTries(iteration: string): string {
    let scope = iteration;
    while (scope.endsWith(TRY_SEGMENT) && scope.includes(SEPARATOR))
        scope = scope.slice(0, scope.lastIndexOf(SEPARATOR));
    return scope;
}

/** The rows of one scope: the iteration itself and everything nested under it. */
function inScope(iteration: string, prefix: string): boolean {
    return iteration === prefix || iteration.startsWith(`${prefix}${SEPARATOR}`);
}

/**
 * The innermost Try an iteration runs inside, with the iteration the Try's own
 * step has and the prefix of its body, or null when no Try encloses it.
 */
function enclosingTry(
    graph: core.AutomationGraph,
    iteration: string
): { tryId: string; parent: string; prefix: string } | null {
    const segments = iteration.split(SEPARATOR);
    for (let at = segments.length - 1; at >= 1; at--) {
        const segment = segments[at]!;
        const id = segment.slice(0, segment.lastIndexOf(":"));
        if (graph.nodes.find((entry) => entry.id === id)?.type === "core.try")
            return {
                tryId: id,
                parent: segments.slice(0, at).join(SEPARATOR),
                prefix: segments.slice(0, at + 1).join(SEPARATOR)
            };
    }
    return null;
}

/** The innermost loop pass an iteration runs in, skipping Try bodies, given the graph. */
function innermostLoopPass(
    graph: core.AutomationGraph,
    iteration: string
): { parent: string; loopId: string; pass: number } | null {
    const segments = iteration.split(SEPARATOR);
    for (let at = segments.length - 1; at >= 1; at--) {
        const found = innermostPass(segments.slice(0, at + 1).join(SEPARATOR));
        const type = graph.nodes.find((entry) => entry.id === found?.loopId)?.type;
        if (found && type && core.isLoopNode(type)) return found;
    }
    return null;
}

/** The innermost loop pass an iteration runs in, or null at the top of a lane. */
function innermostPass(iteration: string): { parent: string; loopId: string; pass: number } | null {
    const at = iteration.lastIndexOf(SEPARATOR);
    if (at < 0) return null;
    const segment = iteration.slice(at + 1);
    const colon = segment.lastIndexOf(":");
    const pass = Number(segment.slice(colon + 1));
    if (colon < 1 || !Number.isInteger(pass)) return null;
    return { parent: iteration.slice(0, at), loopId: segment.slice(0, colon), pass };
}

/** Every node a step leaving by `port` continues into; `port` may list several. */
function leaving(graph: core.AutomationGraph, nodeId: string, port: string | null): string[] {
    if (!port) return [];
    return port.split(",").flatMap((one) => core.successors(graph, nodeId, one));
}

const ACTIVE = ["ready", "running", "waiting"];

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

type RunRow = NonNullable<Awaited<ReturnType<typeof readRun>>>;

async function readRun(runId: string) {
    return prisma.automationRun.findUnique({
        where: { id: runId },
        select: {
            id: true,
            automationId: true,
            versionId: true,
            status: true,
            test: true,
            finally: true,
            outcome: true,
            lockToken: true,
            stepCount: true,
            bytes: true,
            error: true,
            cause: true,
            depth: true,
            parentRunId: true,
            parentStepId: true,
            startedAt: true,
            queuedAt: true,
            automation: {
                select: {
                    id: true,
                    name: true,
                    runAsId: true,
                    orgId: true,
                    userId: true,
                    allowLocalNetwork: true
                }
            }
        }
    });
}

/**
 * Step one run as far as it goes now: until it waits, ends, or this process
 * loses the lease. Returns without doing anything when another process holds it.
 */
export async function advanceRun(runId: string): Promise<void> {
    if (stopping) return;
    const token = randomBytes(9).toString("hex");
    const now = new Date();
    const claimed = await prisma.automationRun.updateMany({
        where: {
            id: runId,
            status: "running",
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }]
        },
        data: { lockedUntil: new Date(now.getTime() + L.leaseMs), lockToken: token }
    });
    if (claimed.count !== 1) return;
    try {
        await stepLoop(runId, token);
    } finally {
        await prisma.automationRun.updateMany({
            where: { id: runId, lockToken: token },
            data: { lockedUntil: null, lockToken: null }
        });
    }
}

interface StepRow {
    id: string;
    nodeId: string;
    iteration: string;
    attempt: number;
    status: string;
    port: string | null;
    waitUntil: Date | null;
    waitKey: string | null;
    createdAt: Date;
}

async function stepLoop(runId: string, token: string): Promise<void> {
    let repaired = false;
    for (let guard = 0; guard <= L.stepsPerRun + 10; guard++) {
        if (stopping) return;
        const run = await readRun(runId);
        if (!run || run.status !== "running" || run.lockToken !== token) return;
        const graph = await loadGraph(run.versionId);
        if (!graph) {
            await finalize(
                run,
                "failed",
                run.finally === "none" ? "none" : "failed",
                "graphUnreadable"
            );
            return;
        }
        const startedAt = (run.startedAt ?? run.queuedAt).getTime();
        if (run.finally === "none" && Date.now() - startedAt > L.runLifetimeMs) {
            await failLane(run, graph, MAIN, "timedOut", "runTooLong");
            continue;
        }
        const lane = run.finally === "pending" ? FINALLY : MAIN;
        const steps = await laneSteps(runId, lane);

        // A process that died between finishing a step and enqueuing what follows
        // it left a token nowhere: put it back, once per claim.
        if (!repaired) {
            repaired = true;
            if (await repairLeftTokens(runId, graph, steps)) continue;
        }

        // A step left `running` under a lease this process just took was cut off.
        const cutOff = steps.find((step) => step.status === "running");
        if (cutOff) {
            await recoverInterrupted(run, graph, cutOff);
            continue;
        }

        const ready = steps.find(
            (step) => step.status === "ready" && !joinHeld(graph, steps, step)
        );
        if (!ready) {
            if (await rethrowUnrecovered(run, graph, steps)) continue;
            if (await settleTries(run, graph, steps)) continue;
            if (await settleLoops(run, graph, steps)) continue;
            if (await settleCalls(steps)) continue;
            const waiting = steps.filter((step) => step.status === "waiting");
            if (waiting.length > 0) {
                const timed = waiting.filter((step) => step.waitUntil);
                const dueAt = timed.length
                    ? new Date(Math.min(...timed.map((step) => step.waitUntil!.getTime())))
                    : null;
                await prisma.automationRun.updateMany({
                    where: { id: runId, lockToken: token },
                    data: { status: "waiting", dueAt }
                });
                return;
            }
            const held = steps.find((step) => step.status === "ready");
            if (!held) {
                await endLane(run, graph, lane, steps);
                continue;
            }
            // Nothing can arrive any more: a held Join goes on with what it has.
            await executeStep(run, graph, held, steps);
            continue;
        }
        if (run.stepCount >= L.stepsPerRun) {
            await failLane(run, graph, lane, "failed", "tooManySteps");
            continue;
        }
        if (run.bytes >= L.runDataBytes) {
            await failLane(run, graph, lane, "failed", "tooMuchData");
            continue;
        }
        const renewed = await prisma.automationRun.updateMany({
            where: { id: runId, lockToken: token },
            data: { lockedUntil: new Date(Date.now() + L.leaseMs) }
        });
        if (renewed.count !== 1) return;
        await executeStep(run, graph, ready, steps);
    }
}

const STEP_SELECT = {
    id: true,
    nodeId: true,
    iteration: true,
    attempt: true,
    status: true,
    port: true,
    waitUntil: true,
    waitKey: true,
    createdAt: true
} as const;

/**
 * A lane's rows, oldest first: every active one, and the newest finished ones.
 * A finished row's successors are newer than it, so none of them is left out.
 */
async function laneSteps(runId: string, lane: string): Promise<StepRow[]> {
    const [active, finished] = await Promise.all([
        prisma.automationStep.findMany({
            where: { runId, iteration: { startsWith: lane }, status: { in: ACTIVE } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: L.stepsPerRun * 2 + 10,
            select: STEP_SELECT
        }),
        prisma.automationStep.findMany({
            where: { runId, iteration: { startsWith: lane }, status: { notIn: ACTIVE } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: L.stepsPerRun * 2 + 10,
            select: STEP_SELECT
        })
    ]);
    return [...active, ...finished].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
    );
}

/** Enqueue the successors of finished steps that have no row: the one write a crash can lose. */
async function repairLeftTokens(
    runId: string,
    graph: core.AutomationGraph,
    steps: readonly StepRow[]
): Promise<boolean> {
    const have = new Set(steps.map((step) => `${step.nodeId}|${step.iteration}`));
    const missing = new Map<string, string[]>();
    for (const step of steps) {
        if (!["ok", "failed", "skipped", "interrupted"].includes(step.status)) continue;
        for (const next of leaving(graph, step.nodeId, step.port)) {
            if (have.has(`${next}|${step.iteration}`)) continue;
            missing.set(step.iteration, [...(missing.get(step.iteration) ?? []), next]);
        }
    }
    for (const [iteration, nodes] of missing) await enqueue(runId, nodes, iteration);
    return missing.size > 0;
}

/** Inputs of a Join that have arrived in its iteration: the steps that left by a port wired to it. */
function joinArrivals(
    graph: core.AutomationGraph,
    steps: readonly StepRow[],
    join: StepRow
): { arrived: string[]; inputs: string[] } {
    const wired = graph.edges.filter((edge) => edge.to.node === join.nodeId);
    const inputs = [...new Set(wired.map((edge) => edge.from.node))];
    const arrived = inputs.filter((input) =>
        steps.some(
            (step) =>
                step.nodeId === input &&
                step.iteration === join.iteration &&
                ["ok", "failed", "skipped"].includes(step.status) &&
                wired.some(
                    (edge) =>
                        edge.from.node === input &&
                        (step.port ?? "").split(",").includes(edge.from.port)
                )
        )
    );
    return { arrived, inputs };
}

/**
 * Whether a ready Join must wait: some step of its iteration is still active
 * and can reach it, so an input may yet arrive. "any" never waits; "count"
 * waits only until enough have arrived.
 */
function joinHeld(graph: core.AutomationGraph, steps: readonly StepRow[], step: StepRow): boolean {
    const node = graph.nodes.find((entry) => entry.id === step.nodeId);
    if (!node || node.type !== "core.join" || node.enabled === false) return false;
    const config = core.joinConfigSchema.safeParse(node.config);
    const wait = config.success ? config.data : core.joinConfigSchema.parse({});
    if (wait.wait === "any") return false;
    if (wait.wait === "count" && joinArrivals(graph, steps, step).arrived.length >= wait.count)
        return false;
    return steps.some(
        (other) =>
            other.id !== step.id &&
            other.iteration === step.iteration &&
            ACTIVE.includes(other.status) &&
            other.nodeId !== step.nodeId &&
            core.reachableFrom(graph, other.nodeId).has(step.nodeId)
    );
}

async function recoverInterrupted(
    run: RunRow,
    graph: core.AutomationGraph,
    step: StepRow
): Promise<void> {
    const node = graph.nodes.find((entry) => entry.id === step.nodeId);
    const impl = node ? await serverNode(node.type) : null;
    if (impl?.meta.idempotent) {
        await prisma.automationStep.updateMany({
            where: { id: step.id, status: "running" },
            data: { status: "ready" }
        });
        return;
    }
    if (!node) {
        await failLane(run, graph, laneOf(step.iteration), "failed", "interrupted");
        return;
    }
    // A step that may have been sent is never sent again by a retry.
    await handleFailure(run, graph, node, step, {
        code: "interrupted",
        refused: false,
        status: "interrupted",
        from: "running",
        retry: false
    });
}

/** The context a node reads, from the rows: the trigger, and the finished steps it can see. */
async function buildContext(
    run: RunRow,
    iteration: string,
    graph: core.AutomationGraph
): Promise<RunContext> {
    const lane = laneOf(iteration);
    // A step sees its own pass and the passes it runs inside; the Finally lane
    // also sees the top of the main flow. A Try body runs once, so its rows
    // read as part of the scope around it. Nearer passes win, then newer rows.
    const segments = iteration.split(SEPARATOR);
    const enclosing = segments.map((_, at) => segments.slice(0, at + 1).join(SEPARATOR));
    if (lane === FINALLY) enclosing.unshift(MAIN);
    const lanes = [...new Set(enclosing.map(laneOf))];
    const done = await prisma.automationStep.findMany({
        where: {
            runId: run.id,
            OR: [
                { iteration: { in: enclosing } },
                ...lanes.map((root) => ({
                    iteration: { startsWith: `${root}${SEPARATOR}`, endsWith: TRY_SEGMENT }
                }))
            ],
            status: { in: ["ok", "failed", "skipped"] },
            port: { not: null }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: L.stepsPerRun * 2,
        select: { nodeId: true, output: true, iteration: true }
    });
    const scopes = new Set(enclosing);
    const visible = done
        .filter((step) => scopes.has(outsideTries(step.iteration)))
        .sort((a, b) => b.iteration.length - a.iteration.length);
    const steps: Record<string, unknown> = {};
    for (const step of visible)
        if (step.output !== null && !Object.hasOwn(steps, step.nodeId))
            steps[step.nodeId] = step.output;
    const cause = (run.cause ?? {}) as Record<string, unknown>;
    const pass = innermostLoopPass(graph, iteration);
    let item: unknown;
    if (pass) {
        const loop = await prisma.automationStep.findFirst({
            where: { runId: run.id, nodeId: pass.loopId, iteration: pass.parent },
            select: { input: true }
        });
        const items = (loop?.input as { items?: unknown[] } | null)?.items;
        item = Array.isArray(items) ? items[pass.pass] : pass.pass;
    }
    const inputs = cause.inputs;
    return {
        trigger: cause,
        steps,
        run: {
            id: run.id,
            startedAt: run.startedAt?.toISOString() ?? null,
            status: run.outcome,
            error: run.error
        },
        automation: { id: run.automation.id, name: run.automation.name },
        now: new Date().toISOString(),
        ...(pass ? { item, index: pass.pass } : {}),
        ...(inputs && typeof inputs === "object"
            ? { inputs: inputs as Record<string, unknown> }
            : {})
    };
}

function withTimeout<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new StepError("timeout"));
        }, ms);
    });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Nodes the engine runs itself, because they steer the run rather than do anything outside it. */
const CONTROL_TYPES = new Set([
    "core.join",
    "core.forEach",
    "core.repeat",
    "core.stop",
    "core.waitEvent",
    "core.run",
    "core.try",
    "core.waitCondition"
]);

/** What a control node asks of the engine besides an ordinary result. */
type ControlResult =
    | NodeResult
    | {
          readonly hold: {
              readonly waitKey: string;
              readonly until?: Date;
              readonly input?: unknown;
              readonly output?: unknown;
          };
          readonly start?: { readonly iteration: string; readonly nodes: string[] };
      }
    | { readonly stop: { readonly as: StopAs; readonly reason: string } };

async function executeStep(
    run: RunRow,
    graph: core.AutomationGraph,
    step: StepRow,
    steps: readonly StepRow[]
): Promise<void> {
    const lane = laneOf(step.iteration);
    const node = graph.nodes.find((entry) => entry.id === step.nodeId);
    if (!node) {
        // i18n-ignore: a stored error code, read through runErrors
        await finishStep(step.id, { status: "failed", error: "nodeMissing" });
        await failLane(run, graph, lane, "failed", "nodeMissing");
        return;
    }
    const pass = core.passPort(node.type, node);
    if (node.enabled === false) {
        // A switched-off node passes its token through its first port.
        const done = await finishStep(step.id, {
            status: "skipped",
            port: pass ?? "",
            from: "ready"
        });
        if (done) await enqueue(run.id, leaving(graph, node.id, pass), step.iteration);
        return;
    }
    if (run.test && node.pinned !== undefined && core.canPin(node.type)) {
        // A pinned sample stands in for the node in a test run: nothing is sent.
        const port = core.nodePorts(node.type, node)[0]!;
        const output = core.capStored(node.pinned, L.stepDataBytes) as object;
        const done = await finishStep(step.id, { status: "ok", port, output, from: "ready" });
        if (done) {
            await count(run.id, output);
            await enqueue(run.id, core.successors(graph, node.id, port), step.iteration);
        }
        return;
    }
    const impl = await serverNode(node.type);
    if (!impl || (!impl.run && !CONTROL_TYPES.has(node.type))) {
        // i18n-ignore: a stored error code, read through runErrors
        await finishStep(step.id, { status: "refused", error: "appMissing", from: "ready" });
        await failLane(run, graph, lane, "refused", "appMissing");
        return;
    }
    const actor = await automationRunner(run.automation);
    if (!actor) {
        // i18n-ignore: a stored error code, read through runErrors
        await finishStep(step.id, { status: "refused", error: "runAsGone", from: "ready" });
        await failLane(run, graph, lane, "refused", "runAsGone");
        return;
    }
    const config = impl.config.safeParse(node.config);
    if (!config.success) {
        // i18n-ignore: a stored error code, read through runErrors
        await finishStep(step.id, { status: "failed", error: "badConfig", from: "ready" });
        await failLane(run, graph, lane, "failed", "badConfig");
        return;
    }
    const context = await buildContext(run, step.iteration, graph);
    const started = await prisma.automationStep.updateMany({
        where: { id: step.id, status: "ready" },
        data: { status: "running", startedAt: new Date() }
    });
    if (started.count !== 1) return;

    const secrets: string[] = [];
    let input: unknown = null;
    const controller = new AbortController();
    const io: NodeIo = {
        actor,
        runId: run.id,
        automationId: run.automation.id,
        idempotencyKey: `${run.id}:${node.id}:${step.iteration}`,
        depth: run.depth,
        since: step.createdAt,
        leads: (port) => leaving(graph, node.id, port).length > 0,
        incoming: graph.edges
            .filter((edge) => edge.to.node === node.id)
            .map((edge) => edge.from.node),
        shelf: { orgId: run.automation.orgId, userId: run.automation.userId },
        timeZone: graph.timeZone,
        signal: controller.signal,
        allowLocalNetwork:
            run.automation.allowLocalNetwork && (await mayAllowLocalNetwork(actor, run.automation)),
        secret: async (id) => {
            const value = await readSecretForRun(id, run.automation);
            secrets.push(value);
            return value;
        },
        recordInput: (value) => {
            input = value;
        }
    };
    const store = (value: unknown) =>
        core.capStored(core.redactSecrets(value, secrets), L.stepDataBytes) as object;

    try {
        const result: ControlResult = CONTROL_TYPES.has(node.type)
            ? await control(run, graph, node, config.data, context, io, step, steps)
            : await withTimeout(
                  impl.run!(config.data, context, io),
                  impl.timeoutMs ?? L.stepActiveMs,
                  controller
              );
        if ("stop" in result) {
            await finishStep(step.id, {
                status: "ok",
                port: "",
                output: store(result.stop),
                from: "running"
            });
            await count(run.id, result.stop);
            await stopLane(run, graph, lane, result.stop.as);
            return;
        }
        if ("hold" in result) {
            const until = result.hold.until;
            if (until && until.getTime() - Date.now() > L.longestWaitMs)
                throw new StepError("waitTooLong");
            await prisma.automationStep.updateMany({
                where: { id: step.id, status: "running" },
                data: {
                    status: "waiting",
                    waitKey: result.hold.waitKey,
                    waitUntil: until ?? null,
                    input: store(result.hold.input ?? input),
                    ...(result.hold.output !== undefined
                        ? { output: store(result.hold.output) }
                        : {})
                }
            });
            if (result.start) await enqueue(run.id, result.start.nodes, result.start.iteration);
            return;
        }
        if ("wait" in result) {
            const until = result.wait.until;
            if (until.getTime() - Date.now() > L.longestWaitMs) throw new StepError("waitTooLong");
            await prisma.automationStep.updateMany({
                where: { id: step.id, status: "running" },
                data: {
                    status: "waiting",
                    waitUntil: until,
                    waitKey: result.wait.recheck ?? null,
                    input: store(input)
                }
            });
            return;
        }
        const port = result.port ?? "next";
        const output = store(result.output);
        const done = await finishStep(step.id, {
            status: "ok",
            port,
            output,
            input: store(input),
            from: "running"
        });
        if (!done) return;
        await count(run.id, output);
        await enqueue(run.id, leaving(graph, node.id, port), step.iteration);
    } catch (caught) {
        const refused = caught instanceof StepRefusal;
        const code = caught instanceof StepError ? caught.code : "failed";
        if (!(caught instanceof StepError))
            console.error(`polaris: automation step ${node.type} failed:`, caught);
        await handleFailure(run, graph, node, step, {
            code,
            refused,
            status: refused ? "refused" : code === "timeout" ? "timedOut" : "failed",
            from: "running",
            retry: true,
            output:
                caught instanceof StepError && caught.output !== undefined
                    ? store(caught.output)
                    : undefined,
            input: store(input)
        });
    }
}

/** A failure the node may try again: the network, a timeout, a busy or broken receiver. */
export function retryable(code: string): boolean {
    if (code === "timeout" || code === "unreachable") return true;
    const status = /^httpStatus:(\d{3})$/.exec(code);
    if (!status) return false;
    const value = Number(status[1]);
    return value === 429 || value === 408 || value >= 500;
}

/**
 * A step failed: try it again when its retry allows, else follow its "if this
 * fails" rule - carry on by its first port, leave by its error port, or end the lane.
 */
async function handleFailure(
    run: RunRow,
    graph: core.AutomationGraph,
    node: core.GraphNode,
    step: Pick<StepRow, "id" | "nodeId" | "iteration" | "attempt">,
    failure: {
        code: string;
        refused: boolean;
        status: string;
        from: string;
        retry: boolean;
        output?: object;
        input?: object;
    }
): Promise<void> {
    const lane = laneOf(step.iteration);
    const { code, refused, output, input, from } = failure;
    if (
        failure.retry &&
        !refused &&
        node.retry &&
        step.attempt < node.retry.tries &&
        retryable(code)
    ) {
        const next = step.attempt + 1;
        const done = await finishStep(step.id, {
            status: "retried",
            error: code,
            output,
            input,
            from
        });
        if (!done) return;
        await prisma.automationStep.createMany({
            data: [
                {
                    runId: run.id,
                    nodeId: node.id,
                    iteration: step.iteration,
                    attempt: next,
                    status: "waiting",
                    waitKey: "retry",
                    waitUntil: new Date(Date.now() + core.retryDelayMs(node.retry, next))
                }
            ],
            skipDuplicates: true
        });
        return;
    }
    const detail = { error: code, ...(output ? { detail: output } : {}) };
    const port = refused
        ? null
        : node.onError === "continue"
          ? core.passPort(node.type, node)
          : node.onError === "port" && core.canTakeErrorPort(node.type)
            ? "error"
            : null;
    if (port !== null) {
        const done = await finishStep(step.id, {
            status: failure.status === "interrupted" ? "interrupted" : "failed",
            error: code,
            port,
            output: core.capStored(detail, L.stepDataBytes) as object,
            input,
            from
        });
        if (done) await enqueue(run.id, leaving(graph, node.id, port), step.iteration);
        return;
    }
    await finishStep(step.id, { status: failure.status, error: code, output, input, from });
    // A refusal is about the run, not the step: no Try catches it.
    if (refused) await failLane(run, graph, lane, "refused", code);
    else await failScope(run, graph, step.iteration, code, node.id);
}

/**
 * A step failed for good: the innermost Try around it leaves by On error and
 * Always, and what was still to do in its body is skipped. With no Try around
 * it, the lane ends as before.
 */
async function failScope(
    run: RunRow,
    graph: core.AutomationGraph,
    iteration: string,
    error: string,
    nodeId: string
): Promise<void> {
    const scope = enclosingTry(graph, iteration);
    if (!scope) {
        await failLane(run, graph, laneOf(iteration), "failed", error);
        return;
    }
    const held = await prisma.automationStep.findFirst({
        where: {
            runId: run.id,
            nodeId: scope.tryId,
            iteration: scope.parent,
            status: "waiting",
            waitKey: TRY_WAIT
        },
        select: { id: true }
    });
    // Already settled: a crash part-way through this, or a second failure in the same body.
    if (!held) return;
    const node = graph.nodes.find((entry) => entry.id === scope.tryId)!;
    const config = core.CORE_NODE_CONFIGS["core.try"].safeParse(node.config);
    const recovered = config.success && config.data.recover;
    const output = { failed: true, error, node: nodeId, recovered };
    // The Try first: once it has left, the stepper skips whatever its body still holds.
    const done = await finishStep(held.id, {
        status: recovered ? "ok" : "failed",
        port: "catch,always",
        error,
        output,
        from: "waiting"
    });
    if (!done) return;
    await skipScope(run.id, scope.prefix);
    await count(run.id, output);
    await enqueue(run.id, leaving(graph, scope.tryId, "catch,always"), scope.parent);
}

/** Skip what is still to do inside one scope, and cancel the runs it was waiting for. */
async function skipScope(runId: string, prefix: string): Promise<void> {
    const where = {
        runId,
        status: { in: ["ready", "waiting"] },
        OR: [{ iteration: prefix }, { iteration: { startsWith: `${prefix}${SEPARATOR}` } }]
    };
    const calls = await prisma.automationStep.findMany({
        where: { ...where, waitKey: { startsWith: CALL_WAIT } },
        select: { waitKey: true },
        take: L.stepsPerRun
    });
    await prisma.automationStep.updateMany({
        where,
        data: { status: "skipped", finishedAt: new Date() }
    });
    for (const call of calls) await cancelRun(call.waitKey!.slice(CALL_WAIT.length), "callerEnded");
}

/**
 * A Try whose body failed and that does not mark it recovered passes the
 * failure on once everything after it (On error, Always, Then) is done: to the
 * Try around it, or to the lane. Passed on first and marked after, so a crash
 * in between passes it on again, which finds the outer scope already settled.
 */
async function rethrowUnrecovered(
    run: RunRow,
    graph: core.AutomationGraph,
    steps: readonly StepRow[]
): Promise<boolean> {
    const failed = steps.filter(
        (step) =>
            step.status === "failed" &&
            step.waitKey === TRY_WAIT &&
            (step.port ?? "").split(",").includes("catch")
    );
    for (const step of failed) {
        const after = core.reachableFrom(graph, step.nodeId);
        const busy = steps.some(
            (other) =>
                other.id !== step.id &&
                ACTIVE.includes(other.status) &&
                other.iteration === step.iteration &&
                after.has(other.nodeId)
        );
        if (busy) continue;
        const row = await prisma.automationStep.findUnique({
            where: { id: step.id },
            select: { error: true }
        });
        await failScope(run, graph, step.iteration, row?.error ?? "failed", step.nodeId);
        await prisma.automationStep.updateMany({
            where: { id: step.id, waitKey: TRY_WAIT },
            data: { waitKey: RETHROWN }
        });
        return true;
    }
    return false;
}

/**
 * A Try whose body has nothing left to do and did not fail leaves by Then and
 * Always. A Try that already left (a crash between leaving and skipping its
 * body) has the rest of its body skipped here.
 */
async function settleTries(
    run: RunRow,
    graph: core.AutomationGraph,
    steps: readonly StepRow[]
): Promise<boolean> {
    const tries = steps
        .filter((step) => step.waitKey === TRY_WAIT || step.waitKey === RETHROWN)
        .sort((a, b) => b.iteration.length - a.iteration.length);
    for (const held of tries) {
        const prefix = tryIteration(held.iteration, held.nodeId);
        const inside = steps.filter((step) => inScope(step.iteration, prefix));
        const busy = inside.some((step) => ACTIVE.includes(step.status));
        if (held.status !== "waiting") {
            if (!busy) continue;
            await skipScope(run.id, prefix);
            return true;
        }
        if (busy) continue;
        if (inside.length === 0) {
            // Held, but its body was never written: a crash between the two.
            await enqueue(run.id, core.successors(graph, held.nodeId, "body"), prefix);
            return true;
        }
        const output = { failed: false, recovered: false };
        const done = await finishStep(held.id, {
            status: "ok",
            port: "then,always",
            output,
            from: "waiting"
        });
        if (done) {
            await count(run.id, output);
            await enqueue(run.id, leaving(graph, held.nodeId, "then,always"), held.iteration);
        }
        return true;
    }
    return false;
}

async function count(runId: string, output: unknown): Promise<void> {
    const bytes = core.byteLength(JSON.stringify(output ?? null));
    await prisma.automationRun.update({
        where: { id: runId },
        data: { stepCount: { increment: 1 }, bytes: { increment: bytes } }
    });
}

async function finishStep(
    stepId: string,
    change: {
        status: string;
        port?: string;
        error?: string;
        output?: object;
        input?: object;
        from?: string;
    }
): Promise<boolean> {
    const done = await prisma.automationStep.updateMany({
        where: { id: stepId, ...(change.from ? { status: change.from } : {}) },
        data: {
            status: change.status,
            port: change.port ?? null,
            error: change.error ?? null,
            ...(change.output !== undefined ? { output: change.output } : {}),
            ...(change.input !== undefined ? { input: change.input } : {}),
            finishedAt: new Date()
        }
    });
    return done.count === 1;
}

// ---------------------------------------------------------------------------
// Control nodes
// ---------------------------------------------------------------------------

type JoinConfig = core.JoinConfig;
type ForEachConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.forEach"]["parse"]>;
type WaitEventConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.waitEvent"]["parse"]>;
type RunConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.run"]["parse"]>;
type StopConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.stop"]["parse"]>;

/** The key a Wait for an event waits under: the shelf and the event's name. */
export function eventWaitKey(
    shelf: { orgId: string | null; userId: string | null },
    name: string
): string {
    return `event:${shelf.orgId ? `org:${shelf.orgId}` : `user:${shelf.userId ?? ""}`}:${name}`;
}

async function control(
    run: RunRow,
    graph: core.AutomationGraph,
    node: core.GraphNode,
    config: unknown,
    context: RunContext,
    io: NodeIo,
    step: StepRow,
    steps: readonly StepRow[]
): Promise<ControlResult> {
    switch (node.type) {
        case "core.join":
            return { output: joinOutput(graph, steps, step, config as JoinConfig, context) };
        case "core.forEach": {
            const loop = config as ForEachConfig;
            const value = core.referenceValue(loop.items, context);
            if (!Array.isArray(value)) throw new StepError("notAList");
            if (value.length > L.loopItems) throw new StepError("tooManyItems");
            const batches: unknown[] = [];
            for (let at = 0; at < value.length; at += loop.batch)
                batches.push(loop.batch === 1 ? value[at] : value.slice(at, at + loop.batch));
            if (core.byteLength(JSON.stringify(batches)) > L.stepDataBytes)
                throw new StepError("listTooLarge");
            return startLoop(
                graph,
                node,
                step,
                { count: value.length, passes: batches.length },
                batches
            );
        }
        case "core.repeat": {
            const repeat = config as core.RepeatConfig;
            const passes = repeat.kind === "times" ? repeat.count : repeat.max;
            if (
                repeat.kind === "until" &&
                core.checkCondition(repeat.condition, { ...context, index: 0 })
            )
                return { output: { passes: 0 }, port: "done" };
            return startLoop(graph, node, step, { passes }, null);
        }
        case "core.stop": {
            const stop = config as StopConfig;
            return {
                stop: { as: stop.as, reason: core.interpolate(stop.reason, context).slice(0, 200) }
            };
        }
        case "core.waitEvent": {
            const wait = config as WaitEventConfig;
            const seconds = core.durationSeconds(wait.timeout);
            return {
                hold: {
                    waitKey: eventWaitKey(io.shelf, wait.name),
                    until: new Date(Date.now() + seconds * 1000),
                    input: { name: wait.name, timeoutSeconds: seconds }
                }
            };
        }
        case "core.run":
            return callAutomation(run, config as RunConfig, context, step);
        case "core.try": {
            const body = core.successors(graph, node.id, "body");
            if (body.length === 0)
                return { output: { failed: false, recovered: false }, port: "then,always" };
            return {
                hold: { waitKey: TRY_WAIT, input: {} },
                start: { iteration: tryIteration(step.iteration, node.id), nodes: body }
            };
        }
        case "core.waitCondition": {
            const wait = config as core.WaitConditionConfig;
            if (core.checkCondition(wait.condition, context))
                return { output: { matched: true, checks: 1, timedOut: false } };
            const now = Date.now();
            const timeout = core.durationSeconds(wait.timeout) * 1000;
            const every = core.durationSeconds(wait.every) * 1000;
            const deadline = new Date(now + timeout);
            return {
                hold: {
                    waitKey: conditionWaitKey(io.shelf),
                    until: new Date(Math.min(now + every, deadline.getTime())),
                    input: { deadline: deadline.toISOString(), everySeconds: every / 1000 },
                    output: { matched: false, checks: 1, timedOut: false }
                }
            };
        }
        default:
            throw new StepError("appMissing");
    }
}

/** What a Join hands on: each arrived input by node id, all of them in a list, or one kept. */
function joinOutput(
    graph: core.AutomationGraph,
    steps: readonly StepRow[],
    step: StepRow,
    config: JoinConfig,
    context: RunContext
): Record<string, unknown> {
    const { arrived, inputs } = joinArrivals(graph, steps, step);
    const missing = inputs.filter((input) => !arrived.includes(input));
    const data: Record<string, unknown> = {};
    for (const id of arrived) data[id] = context.steps[id] ?? null;
    if (config.output === "append")
        return { items: arrived.map((id) => data[id]), arrived, missing };
    if (config.output === "keep") {
        const kept = config.keep && arrived.includes(config.keep) ? config.keep : arrived[0];
        const value = kept ? data[kept] : null;
        return { inputs: kept ? { [kept]: value } : {}, items: [value], arrived, missing };
    }
    return { inputs: data, arrived, missing };
}

/** Start the first pass of a loop; the loop's step waits until its last pass is over. */
function startLoop(
    graph: core.AutomationGraph,
    node: core.GraphNode,
    step: StepRow,
    totals: { count?: number; passes: number },
    items: unknown[] | null
): ControlResult {
    const body = core.successors(graph, node.id, "each");
    if (totals.passes === 0 || body.length === 0)
        return { output: { ...totals, passes: totals.passes }, port: "done" };
    return {
        hold: {
            waitKey: "loop",
            input: items ? { items } : { passes: totals.passes },
            output: { ...totals, pass: 0 }
        },
        start: { iteration: passIteration(step.iteration, node.id, 0), nodes: body }
    };
}

/**
 * A loop whose current pass has nothing left to do starts its next pass, or
 * leaves by "done". The next pass is counted from the rows, so a pass started
 * just before a crash is never started twice nor skipped.
 */
async function settleLoops(
    run: RunRow,
    graph: core.AutomationGraph,
    steps: readonly StepRow[]
): Promise<boolean> {
    const loops = steps
        .filter((step) => step.status === "waiting" && step.waitKey === "loop")
        .sort((a, b) => b.iteration.length - a.iteration.length);
    for (const loop of loops) {
        const prefix = `${loop.iteration}${SEPARATOR}${loop.nodeId}:`;
        const busy = steps.some(
            (step) => step.iteration.startsWith(prefix) && ACTIVE.includes(step.status)
        );
        if (busy) continue;
        const node = graph.nodes.find((entry) => entry.id === loop.nodeId);
        const row = await prisma.automationStep.findUnique({
            where: { id: loop.id },
            select: { output: true, input: true }
        });
        const state = (row?.output ?? {}) as { pass?: number; passes?: number; count?: number };
        const totals = (row?.input ?? {}) as { items?: unknown[]; passes?: number };
        const passes = Array.isArray(totals.items) ? totals.items.length : (totals.passes ?? 0);
        let seen = state.pass ?? 0;
        for (const step of steps) {
            if (!step.iteration.startsWith(prefix)) continue;
            const pass = Number(step.iteration.slice(prefix.length).split(SEPARATOR)[0]);
            if (Number.isInteger(pass) && pass > seen) seen = pass;
        }
        let next = seen + 1;
        if (next < passes && node?.type === "core.repeat") {
            const repeat = core.repeatConfigSchema.safeParse(node.config);
            if (repeat.success && repeat.data.kind === "until") {
                const context = await buildContext(
                    run,
                    passIteration(loop.iteration, loop.nodeId, seen),
                    graph
                );
                if (core.checkCondition(repeat.data.condition, { ...context, index: next }))
                    next = passes + 1;
            }
        }
        if (next < passes) {
            const body = core.successors(graph, loop.nodeId, "each");
            await enqueue(run.id, body, passIteration(loop.iteration, loop.nodeId, next));
            await prisma.automationStep.updateMany({
                where: { id: loop.id, status: "waiting" },
                data: { output: { ...state, pass: next } }
            });
            return true;
        }
        const output = {
            ...(state.count !== undefined ? { count: state.count } : {}),
            passes: Math.min(seen + 1, passes)
        };
        const done = await finishStep(loop.id, {
            status: "ok",
            port: "done",
            output,
            from: "waiting"
        });
        if (done) {
            await count(run.id, output);
            await enqueue(run.id, core.successors(graph, loop.nodeId, "done"), loop.iteration);
        }
        return true;
    }
    return false;
}

/** Start the called automation (once per step, by its firing key) and wait for it or carry on. */
async function callAutomation(
    run: RunRow,
    config: RunConfig,
    context: RunContext,
    step: StepRow
): Promise<ControlResult> {
    const target = await prisma.automation.findUnique({
        where: { id: config.automationId },
        select: { id: true, orgId: true, userId: true, enabled: true, publishedVersionId: true }
    });
    const sameShelf =
        target &&
        (run.automation.orgId
            ? target.orgId === run.automation.orgId
            : !target.orgId && target.userId === run.automation.userId);
    if (!target || !sameShelf) throw new StepRefusal("callForbidden");
    if (run.depth + 1 > L.depth) throw new StepRefusal("loop");
    if (!target.enabled || !target.publishedVersionId) throw new StepError("callOff");
    const graph = await loadGraph(target.publishedVersionId);
    const called = graph?.nodes.find(
        (entry) => entry.type === "core.called" && entry.enabled !== false
    );
    if (!called) throw new StepError("callNoTrigger");
    const declared = core.calledConfigSchema.parse(called.config ?? {}).inputs;
    const inputs = callInputs(declared, config.inputs, context);
    const child = await startRun({
        automationId: target.id,
        versionId: target.publishedVersionId,
        triggerNodeId: called.id,
        firingKey: `call:${step.id}`,
        cause: {
            id: called.id,
            at: new Date().toISOString(),
            kind: "call",
            inputs,
            callerRunId: run.id
        },
        depth: run.depth + 1,
        parentRunId: run.id,
        parentStepId: step.id
    });
    if (!child) throw new StepError("callOff");
    if (!config.wait) return { output: { runId: child.id, status: child.status } };
    if (core.runFinished(child.status)) {
        const answer = await childAnswer(child.id, child.status);
        if (answer.failed) throw new StepError("callFailed", answer.output);
        return { output: answer.output };
    }
    return {
        hold: { waitKey: `${CALL_WAIT}${child.id}`, input: { automationId: target.id, inputs } }
    };
}

/** A call's inputs, typed by what the called automation declares. Undeclared names are dropped. */
export function callInputs(
    declared: core.CalledConfig["inputs"],
    given: readonly { name: string; value: string }[],
    context: unknown
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const input of declared) {
        const pair = given.find((entry) => entry.name === input.name);
        const raw = pair ? core.referenceValue(pair.value, context) : undefined;
        const empty = raw === undefined || raw === null || raw === "";
        if (empty) {
            if (input.required) throw new StepError("callInputMissing", { input: input.name });
            continue;
        }
        if (input.kind === "number") {
            const value = typeof raw === "number" ? raw : Number(raw);
            if (!Number.isFinite(value))
                throw new StepError("callInputInvalid", { input: input.name });
            out[input.name] = value;
        } else if (input.kind === "boolean") {
            out[input.name] = raw === true || raw === "true";
        } else if (input.kind === "json") {
            if (typeof raw !== "string") out[input.name] = raw;
            else
                try {
                    out[input.name] = JSON.parse(raw);
                } catch {
                    throw new StepError("callInputInvalid", { input: input.name });
                }
        } else out[input.name] = typeof raw === "string" ? raw : JSON.stringify(raw);
    }
    if (core.byteLength(JSON.stringify(out)) > L.eventPayloadBytes)
        throw new StepError("callInputInvalid");
    return out;
}

/** A finished child run's answer: its status, and what its last Answer step gave. */
async function childAnswer(
    childId: string,
    status: string
): Promise<{ failed: boolean; output: Record<string, unknown> }> {
    const child = await prisma.automationRun.findUnique({
        where: { id: childId },
        select: { versionId: true, error: true }
    });
    const graph = child ? await loadGraph(child.versionId) : null;
    const answers = new Set(
        (graph?.nodes ?? [])
            .filter((entry) => entry.type === "core.answer")
            .map((entry) => entry.id)
    );
    const rows = answers.size
        ? await prisma.automationStep.findMany({
              where: { runId: childId, status: "ok", nodeId: { in: [...answers] } },
              orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { output: true }
          })
        : [];
    const outputs = ((rows[0]?.output ?? {}) as { outputs?: unknown }).outputs ?? {};
    return {
        failed: !["succeeded", "stopped"].includes(status),
        output: { runId: childId, status, outputs, ...(child?.error ? { error: child.error } : {}) }
    };
}

/** The waits for a called run whose end may not have reached them. */
function callWaits(steps: readonly Pick<StepRow, "status" | "waitKey">[]): string[] {
    return steps
        .filter((step) => step.status === "waiting" && step.waitKey?.startsWith(CALL_WAIT))
        .map((step) => step.waitKey!.slice(CALL_WAIT.length))
        .filter(isUuid);
}

/**
 * Steps waiting for a run that already ended go on: the child ended before the
 * wait was written, or its end was cut off before it told the caller.
 */
async function resumeCalls(children: readonly string[]): Promise<string[]> {
    if (children.length === 0) return [];
    const ended = await prisma.automationRun.findMany({
        where: { id: { in: [...children] }, status: { in: [...core.FINISHED_RUN_STATUSES] } },
        select: { id: true, parentRunId: true }
    });
    const runs = new Set<string>();
    for (const child of ended)
        if (child.parentRunId && (await resumeParent(child.id))) runs.add(child.parentRunId);
    return [...runs];
}

async function settleCalls(steps: readonly StepRow[]): Promise<boolean> {
    return (await resumeCalls(callWaits(steps))).length > 0;
}

let callCursor: string | undefined;

/** Callers left waiting for a run that ended, a page per pass. Returns the runs to step. */
export async function resumeEndedCalls(limit = 100): Promise<string[]> {
    const waits = await prisma.automationStep.findMany({
        where: {
            status: "waiting",
            waitKey: { startsWith: CALL_WAIT },
            ...(callCursor ? { id: { gt: callCursor } } : {})
        },
        orderBy: { id: "asc" },
        take: limit,
        select: { id: true, status: true, waitKey: true }
    });
    callCursor = waits.length === limit ? waits.at(-1)!.id : undefined;
    return resumeCalls(callWaits(waits));
}

/** A child run is over: the step of its parent that waits for it goes on. Returns whether it did. */
async function resumeParent(childId: string): Promise<boolean> {
    const child = await prisma.automationRun.findUnique({
        where: { id: childId },
        select: { status: true, parentRunId: true, parentStepId: true }
    });
    if (!child?.parentRunId || !child.parentStepId || !core.runFinished(child.status)) return false;
    const waitingStep = await prisma.automationStep.findFirst({
        where: { id: child.parentStepId, status: "waiting", waitKey: `${CALL_WAIT}${childId}` },
        select: { id: true, nodeId: true, iteration: true, attempt: true }
    });
    if (!waitingStep) return false;
    const parent = await readRun(child.parentRunId);
    const graph = parent ? await loadGraph(parent.versionId) : null;
    const node = graph?.nodes.find((entry) => entry.id === waitingStep.nodeId);
    if (!parent || !graph || !node || core.runFinished(parent.status)) return false;
    // Running first: a crash after this leaves a run the job steps, never one stuck waiting.
    await prisma.automationRun.updateMany({
        where: { id: parent.id, status: "waiting" },
        data: { status: "running", dueAt: null }
    });
    const answer = await childAnswer(childId, child.status);
    const output = core.capStored(answer.output, L.stepDataBytes) as object;
    if (answer.failed) {
        await handleFailure(parent, graph, node, waitingStep, {
            code: "callFailed",
            refused: false,
            status: "failed",
            from: "waiting",
            retry: false,
            output
        });
        return true;
    }
    const done = await finishStep(waitingStep.id, {
        status: "ok",
        port: "next",
        output,
        from: "waiting"
    });
    if (!done) return false;
    await count(parent.id, output);
    await enqueue(parent.id, core.successors(graph, node.id, "next"), waitingStep.iteration);
    return true;
}

/** End a lane early: what was still to do in it is skipped. */
async function failLane(
    run: RunRow,
    graph: core.AutomationGraph,
    lane: string,
    outcome: core.RunStatus,
    error: string
): Promise<void> {
    await skipLane(run.id, lane);
    if (lane === FINALLY) {
        await finalize(
            run,
            (run.outcome as core.RunStatus | null) ?? "succeeded",
            "failed",
            run.error ?? `finally:${error}`
        );
        return;
    }
    await enterFinallyOrFinish(run, graph, outcome, error);
}

async function skipLane(runId: string, lane: string): Promise<void> {
    await prisma.automationStep.updateMany({
        where: { runId, iteration: { startsWith: lane }, status: { in: ["ready", "waiting"] } },
        data: { status: "skipped", finishedAt: new Date() }
    });
    await cancelChildren(runId);
}

/** A Stop node: the lane ends here, as succeeded ("stopped") or as failed. */
async function stopLane(
    run: RunRow,
    graph: core.AutomationGraph,
    lane: string,
    as: StopAs
): Promise<void> {
    await skipLane(run.id, lane);
    if (lane === FINALLY) {
        await finalize(
            run,
            (run.outcome as core.RunStatus | null) ?? "succeeded",
            as === "failed" ? "failed" : "done",
            as === "failed" ? (run.error ?? "finally:stoppedAsFailed") : run.error
        );
        return;
    }
    await enterFinallyOrFinish(
        run,
        graph,
        as === "failed" ? "failed" : as === "skipped" ? "skipped" : "stopped",
        as === "failed" ? "stoppedAsFailed" : null
    );
}

async function endLane(
    run: RunRow,
    graph: core.AutomationGraph,
    lane: string,
    steps: readonly { status: string; port: string | null; iteration: string }[]
): Promise<void> {
    if (lane === FINALLY) {
        // A failure inside a Try was caught there; one it did not recover was passed on.
        const failed = steps.some(
            (step) =>
                ["failed", "refused", "timedOut", "interrupted"].includes(step.status) &&
                !step.port &&
                !enclosingTry(graph, step.iteration)
        );
        await finalize(
            run,
            (run.outcome as core.RunStatus | null) ?? "succeeded",
            failed ? "failed" : "done",
            run.error
        );
        return;
    }
    await enterFinallyOrFinish(run, graph, "succeeded", null);
}

/** The main flow is over, however it ended: run the Finally lane once, or finish. */
async function enterFinallyOrFinish(
    run: RunRow,
    graph: core.AutomationGraph,
    outcome: core.RunStatus,
    error: string | null
): Promise<void> {
    if (graph.finally.entry && run.finally === "none") {
        const moved = await prisma.automationRun.updateMany({
            where: { id: run.id, finally: "none" },
            data: { finally: "pending", outcome, error }
        });
        if (moved.count === 1) await enqueue(run.id, [graph.finally.entry], FINALLY);
        return;
    }
    await finalize(run, outcome, run.finally === "none" ? "none" : "done", error);
}

async function finalize(
    run: RunRow,
    status: core.RunStatus,
    finallyState: core.FinallyState,
    error: string | null
): Promise<void> {
    const ended = await prisma.automationRun.updateMany({
        where: { id: run.id, status: { notIn: [...core.FINISHED_RUN_STATUSES] } },
        data: {
            status,
            finally: finallyState,
            outcome: status,
            error,
            finishedAt: new Date(),
            dueAt: null
        }
    });
    await prisma.automation.update({
        where: { id: run.automationId },
        data: { lastStatus: status }
    });
    if (ended.count === 1) await afterEnd(run, status, error);
    const promoted = await promoteQueued(run.automationId);
    if (promoted)
        void advanceRun(promoted).catch((caught) =>
            console.error("polaris: a queued automation run failed to start:", caught)
        );
}

/** What a run's end sets off: the caller waiting for it, and "An automation failed". */
async function afterEnd(
    run: Pick<RunRow, "id" | "test" | "depth" | "automation">,
    status: string,
    error: string | null
): Promise<void> {
    await resumeParent(run.id);
    await announceFinished(run.id, status, error);
    if (run.test || (status !== "failed" && status !== "timedOut")) return;
    const { emitAutomationEvent } = await import("./outbox");
    await emitAutomationEvent("core.failed", {
        orgId: run.automation.orgId,
        userId: run.automation.userId,
        payload: {
            automationId: run.automation.id,
            automationName: run.automation.name,
            runId: run.id,
            status,
            error
        },
        dedupeKey: run.id,
        depth: run.depth + 1,
        originRunId: run.id
    });
}

/**
 * "automation.finished" on the run's shelf, for every live run however it
 * ended: one level deeper, never starting the same automation again (the
 * outbox skips the automation a run's own event came from), and held to the
 * shelf's announce rate so a chain of them cannot flood it.
 */
async function announceFinished(runId: string, status: string, error: string | null) {
    const run = await prisma.automationRun.findUnique({
        where: { id: runId },
        select: {
            id: true,
            test: true,
            depth: true,
            automation: { select: { id: true, name: true, orgId: true, userId: true } }
        }
    });
    if (!run || run.test || run.depth + 1 > L.depth) return;
    const shelf = { orgId: run.automation.orgId, userId: run.automation.userId };
    const recent = await prisma.automationEvent.count({
        where: {
            type: "core.event",
            orgId: shelf.orgId,
            ...(shelf.orgId ? {} : { userId: shelf.userId }),
            createdAt: { gte: new Date(Date.now() - core.RATE_WINDOW_MS) }
        }
    });
    if (recent >= L.announceRate) return;
    const { emitAutomationEvent } = await import("./outbox");
    const name = core.AUTOMATION_FINISHED_EVENT;
    await emitAutomationEvent("core.event", {
        ...shelf,
        subjectKey: name,
        payload: {
            name,
            payload: {
                automationId: run.automation.id,
                automationName: run.automation.name,
                runId: run.id,
                outcome: status,
                error
            }
        },
        dedupeKey: `finished:${run.id}`,
        depth: run.depth + 1,
        originRunId: run.id
    });
}

/** Cancel the runs a run started and is waiting for: a stopped caller has nobody to answer. */
async function cancelChildren(runId: string): Promise<void> {
    const children = await prisma.automationRun.findMany({
        where: { parentRunId: runId, status: { in: ["queued", ...core.ACTIVE_RUN_STATUSES] } },
        select: { id: true },
        take: L.stepsPerRun
    });
    for (const child of children) await cancelRun(child.id, "callerEnded");
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------

/** A step that waits to be run again (an app's "wait until a device is ..."): its wait key starts with this. */
export const RECHECK_PREFIX = "recheck:";

/** Finish every wait that is due and put its run back to work. Returns the runs to step. */
export async function resumeDueWaits(limit = 100): Promise<string[]> {
    const due = await prisma.automationStep.findMany({
        where: { status: "waiting", waitUntil: { lte: new Date() } },
        orderBy: { waitUntil: "asc" },
        take: limit,
        select: {
            id: true,
            runId: true,
            nodeId: true,
            iteration: true,
            waitUntil: true,
            waitKey: true
        }
    });
    const runs = new Set<string>();
    for (const step of due) {
        if (step.waitKey?.startsWith(CONDITION_WAIT)) {
            if (await recheckCondition(step.id, null)) runs.add(step.runId);
            continue;
        }
        const run = await prisma.automationRun.findUnique({
            where: { id: step.runId },
            select: { versionId: true }
        });
        const graph = run ? await loadGraph(run.versionId) : null;
        // Running first: a crash after this leaves a run the job steps, and the
        // stepper re-enqueues a successor a crash kept from being written.
        await prisma.automationRun.updateMany({
            where: { id: step.runId, status: "waiting" },
            data: { status: "running", dueAt: null }
        });
        if (step.waitKey === "retry" || step.waitKey?.startsWith(RECHECK_PREFIX)) {
            await prisma.automationStep.updateMany({
                where: { id: step.id, status: "waiting" },
                data: { status: "ready", waitUntil: null }
            });
            runs.add(step.runId);
            continue;
        }
        const timedOut = step.waitKey?.startsWith("event:") ?? false;
        const port = timedOut ? "timeout" : "next";
        const output = timedOut
            ? { name: step.waitKey!.split(":").slice(3).join(":"), payload: null, timedOut: true }
            : { waitedUntil: step.waitUntil?.toISOString() ?? null };
        const done = await finishStep(step.id, { status: "ok", port, output, from: "waiting" });
        if (!done) continue;
        if (graph)
            await enqueue(step.runId, core.successors(graph, step.nodeId, port), step.iteration);
        runs.add(step.runId);
    }
    return [...runs];
}

/**
 * An automation event reached the shelf: every Wait for an event under that
 * name whose filter holds goes on. Returns the runs to step.
 */
export async function resumeEventWaits(
    shelf: { orgId: string | null; userId: string | null },
    name: string,
    payload: Record<string, unknown>,
    limit = 100
): Promise<string[]> {
    const runs = new Set<string>();
    let cursor: string | undefined;
    do {
        const waiting = await prisma.automationStep.findMany({
            where: {
                status: "waiting",
                waitKey: eventWaitKey(shelf, name),
                ...(cursor ? { id: { gt: cursor } } : {})
            },
            orderBy: { id: "asc" },
            take: limit,
            select: { id: true, runId: true, nodeId: true, iteration: true }
        });
        cursor = waiting.length === limit ? waiting.at(-1)!.id : undefined;
        const owners = await prisma.automationRun.findMany({
            where: { id: { in: [...new Set(waiting.map((step) => step.runId))] } },
            select: { id: true, versionId: true, status: true }
        });
        const byId = new Map(owners.map((run) => [run.id, run]));
        for (const step of waiting) {
            const run = byId.get(step.runId);
            const graph = run ? await loadGraph(run.versionId) : null;
            const node = graph?.nodes.find((entry) => entry.id === step.nodeId);
            if (!run || !graph || !node || core.runFinished(run.status)) continue;
            const config = core.CORE_NODE_CONFIGS["core.waitEvent"].safeParse(node.config);
            if (
                config.success &&
                ((config.data.filter &&
                    !core.checkCondition(config.data.filter, { event: payload })) ||
                    !core.takesOutcome(config.data.name, config.data.outcomes, payload))
            )
                continue;
            await prisma.automationRun.updateMany({
                where: { id: step.runId, status: "waiting" },
                data: { status: "running", dueAt: null }
            });
            const output = core.capStored(
                { name, payload, timedOut: false },
                L.stepDataBytes
            ) as object;
            const done = await finishStep(step.id, {
                status: "ok",
                port: "next",
                output,
                from: "waiting"
            });
            if (!done) continue;
            await enqueue(step.runId, core.successors(graph, step.nodeId, "next"), step.iteration);
            runs.add(step.runId);
        }
    } while (cursor);
    return [...runs];
}

/** The wait key of a Wait for a condition: rechecked by every automation event on its shelf. */
const CONDITION_WAIT = "condition:";

export function conditionWaitKey(shelf: { orgId: string | null; userId: string | null }): string {
    return `${CONDITION_WAIT}${shelf.orgId ? `org:${shelf.orgId}` : `user:${shelf.userId ?? ""}`}`;
}

/**
 * Check a Wait for a condition again, on the clock (`event` null) or because
 * an automation event reached its shelf. It goes on by "next" once the
 * condition holds, by "timeout" once its time is up, and otherwise waits for
 * the next check. Returns the run to step, or null.
 */
async function recheckCondition(
    stepId: string,
    event: { name: string; payload: Record<string, unknown> } | null
): Promise<string | null> {
    const step = await prisma.automationStep.findUnique({
        where: { id: stepId },
        select: {
            id: true,
            runId: true,
            nodeId: true,
            iteration: true,
            status: true,
            input: true,
            output: true
        }
    });
    if (!step || step.status !== "waiting") return null;
    const run = await readRun(step.runId);
    const graph = run ? await loadGraph(run.versionId) : null;
    const node = graph?.nodes.find((entry) => entry.id === step.nodeId);
    if (!run || !graph || !node || core.runFinished(run.status)) return null;
    const config = core.waitConditionConfigSchema.safeParse(node.config);
    const input = (step.input ?? {}) as { deadline?: string; everySeconds?: number };
    const checks = ((step.output as { checks?: number } | null)?.checks ?? 0) + 1;
    const context = await buildContext(run, step.iteration, graph);
    const matched =
        config.success &&
        core.checkCondition(config.data.condition, event ? { ...context, event } : context);
    const now = Date.now();
    const deadline = input.deadline ? Date.parse(input.deadline) : now;
    if (!matched && now < deadline) {
        // Still waiting: an event leaves the clock alone, a clock check sets the next one.
        const every = Math.max(L.conditionRecheckMinSeconds, input.everySeconds ?? 0) * 1000;
        await prisma.automationStep.updateMany({
            where: { id: step.id, status: "waiting" },
            data: {
                output: { matched: false, checks, timedOut: false },
                ...(event ? {} : { waitUntil: new Date(Math.min(now + every, deadline)) })
            }
        });
        return null;
    }
    // Running first: a crash after this leaves a run the job steps, never one stuck waiting.
    await prisma.automationRun.updateMany({
        where: { id: run.id, status: "waiting" },
        data: { status: "running", dueAt: null }
    });
    const port = matched ? "next" : "timeout";
    const done = await finishStep(step.id, {
        status: "ok",
        port,
        output: { matched, checks, timedOut: !matched },
        from: "waiting"
    });
    if (!done) return null;
    await enqueue(run.id, core.successors(graph, node.id, port), step.iteration);
    return run.id;
}

/** Where the last event's recheck stopped, per shelf with more waits than one event checks. */
const conditionCursors = new Map<string, string>();
const CONDITION_CURSORS = 1000;

/**
 * An automation event reached a shelf: every Wait for a condition on it is
 * checked again, with the event as `event`, bounded per event. Returns the runs to step.
 */
export async function resumeConditionWaits(
    shelf: { orgId: string | null; userId: string | null },
    event: { name: string; payload: Record<string, unknown> }
): Promise<string[]> {
    // Each event starts where the last one stopped, so past the bound every
    // wait still gets its turn instead of the oldest ones every time.
    const key = conditionWaitKey(shelf);
    const after = conditionCursors.get(key);
    const page = (id: object | undefined, take: number) =>
        prisma.automationStep.findMany({
            where: { status: "waiting", waitKey: key, ...(id ? { id } : {}) },
            orderBy: { id: "asc" },
            take,
            select: { id: true }
        });
    const waiting = await page(after ? { gt: after } : undefined, L.conditionWaitsPerEvent);
    if (after && waiting.length < L.conditionWaitsPerEvent)
        waiting.push(...(await page({ lte: after }, L.conditionWaitsPerEvent - waiting.length)));
    conditionCursors.delete(key);
    if (waiting.length === L.conditionWaitsPerEvent) {
        if (conditionCursors.size >= CONDITION_CURSORS)
            conditionCursors.delete(conditionCursors.keys().next().value!);
        conditionCursors.set(key, waiting.at(-1)!.id);
    }
    const runs = new Set<string>();
    for (const step of waiting) {
        const run = await recheckCondition(step.id, event);
        if (run) runs.add(run);
    }
    return [...runs];
}

/** Runs that are ready to step and held by nobody (or by a process that died). */
export async function runnableRuns(limit = 8): Promise<string[]> {
    const rows = await prisma.automationRun.findMany({
        where: {
            status: "running",
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }]
        },
        orderBy: { queuedAt: "asc" },
        take: limit,
        select: { id: true }
    });
    return rows.map((row) => row.id);
}
