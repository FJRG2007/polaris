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
import { randomBytes } from "node:crypto";
import { automationRunner, mayAllowLocalNetwork } from "./runner";
import { serverNode } from "./node-registry";
import { readSecretForRun } from "./secrets";
import { StepError, StepRefusal, type NodeIo, type RunContext } from "./types";

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
            where: { automationId: automation.id, test: false, status: { in: [...core.ACTIVE_RUN_STATUSES] } }
        }),
        prisma.automationRun.count({ where: { automationId: automation.id, test: false, status: "queued" } }),
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
          : core.admitRun({ mode, maxRuns: automation.maxRuns, rateLimit: automation.rateLimit, active, queued, recent });

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
        where: { runId, iteration: MAIN, status: { in: ["ready", "waiting", "running"] } },
        data: { status: "skipped", finishedAt: new Date() }
    });
    const graph = await loadGraph(run.versionId);
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
        where: { runId, iteration: FINALLY, status: { in: ["ready", "waiting"] } },
        data: { status: "skipped", finishedAt: new Date() }
    });
    await promoteQueued(run.automationId);
    return true;
}

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

async function stepLoop(runId: string, token: string): Promise<void> {
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
        const steps = await prisma.automationStep.findMany({
            where: { runId, iteration: lane },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: L.stepsPerRun + 10,
            select: { id: true, nodeId: true, status: true, port: true, waitUntil: true }
        });

        // A step left `running` under a lease this process just took was cut off.
        const cutOff = steps.find((step) => step.status === "running");
        if (cutOff) {
            await recoverInterrupted(run, graph, lane, cutOff);
            continue;
        }

        const ready = steps.find((step) => step.status === "ready");
        if (!ready) {
            const waiting = steps.filter((step) => step.status === "waiting" && step.waitUntil);
            if (waiting.length > 0) {
                const dueAt = new Date(
                    Math.min(...waiting.map((step) => step.waitUntil!.getTime()))
                );
                await prisma.automationRun.updateMany({
                    where: { id: runId, lockToken: token },
                    data: { status: "waiting", dueAt }
                });
                return;
            }
            await endLane(run, graph, lane, steps);
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
        await executeStep(run, graph, lane, ready);
    }
}

async function recoverInterrupted(
    run: RunRow,
    graph: core.AutomationGraph,
    lane: string,
    step: { id: string; nodeId: string }
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
    await prisma.automationStep.updateMany({
        where: { id: step.id, status: "running" },
        data: { status: "interrupted", error: "interrupted", finishedAt: new Date() }
    });
    if (node?.onError === "continue") {
        await prisma.automationStep.updateMany({
            where: { id: step.id },
            data: { port: core.nodePorts(node.type)[0]! }
        });
        await enqueue(run.id, core.successors(graph, node.id, core.nodePorts(node.type)[0]!), lane);
        return;
    }
    await failLane(run, graph, lane, "failed", "interrupted");
}

/** The context a node reads, from the rows: the trigger, and every finished step's output. */
async function buildContext(run: RunRow): Promise<RunContext> {
    const done = await prisma.automationStep.findMany({
        where: { runId: run.id, status: { in: ["ok", "failed"] }, port: { not: null } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: L.stepsPerRun,
        select: { nodeId: true, output: true }
    });
    const steps: Record<string, unknown> = {};
    for (const step of done) steps[step.nodeId] = step.output;
    return {
        trigger: (run.cause ?? {}) as Record<string, unknown>,
        steps,
        run: {
            id: run.id,
            startedAt: run.startedAt?.toISOString() ?? null,
            status: run.outcome,
            error: run.error
        },
        automation: { id: run.automation.id, name: run.automation.name },
        now: new Date().toISOString()
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

async function executeStep(
    run: RunRow,
    graph: core.AutomationGraph,
    lane: string,
    step: { id: string; nodeId: string }
): Promise<void> {
    const node = graph.nodes.find((entry) => entry.id === step.nodeId);
    if (!node) {
        // i18n-ignore: a stored error code, read through runErrors
        await finishStep(step.id, { status: "failed", error: "nodeMissing" });
        await failLane(run, graph, lane, "failed", "nodeMissing");
        return;
    }
    const ports = core.nodePorts(node.type);
    if (node.enabled === false) {
        // A switched-off node passes its token through its first port.
        const done = await finishStep(step.id, {
            status: "skipped",
            port: ports[0]!,
            from: "ready"
        });
        if (done) await enqueue(run.id, core.successors(graph, node.id, ports[0]!), lane);
        return;
    }
    if (run.test && node.pinned !== undefined && core.canPin(node.type)) {
        // A pinned sample stands in for the node in a test run: nothing is sent.
        const output = core.capStored(node.pinned, L.stepDataBytes) as object;
        const done = await finishStep(step.id, { status: "ok", port: ports[0]!, output, from: "ready" });
        if (done) {
            await count(run.id, output);
            await enqueue(run.id, core.successors(graph, node.id, ports[0]!), lane);
        }
        return;
    }
    const impl = await serverNode(node.type);
    if (!impl?.run) {
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
    const context = await buildContext(run);
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
        idempotencyKey: `${run.id}:${node.id}:${lane}`,
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
        const result = await withTimeout(
            impl.run(config.data, context, io),
            impl.timeoutMs ?? L.stepActiveMs,
            controller
        );
        if ("wait" in result) {
            const until = result.wait.until;
            if (until.getTime() - Date.now() > L.longestWaitMs) throw new StepError("waitTooLong");
            await prisma.automationStep.updateMany({
                where: { id: step.id, status: "running" },
                data: { status: "waiting", waitUntil: until, input: store(input) }
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
        await enqueue(run.id, core.successors(graph, node.id, port), lane);
    } catch (caught) {
        const refused = caught instanceof StepRefusal;
        const code = caught instanceof StepError ? caught.code : "failed";
        if (!(caught instanceof StepError))
            console.error(`polaris: automation step ${node.type} failed:`, caught);
        const output =
            caught instanceof StepError && caught.output !== undefined
                ? store(caught.output)
                : undefined;
        if (node.onError === "continue" && !refused) {
            const port = ports[0]!;
            const done = await finishStep(step.id, {
                status: "failed",
                error: code,
                port,
                output: store({ error: code, ...(output ? { detail: output } : {}) }),
                input: store(input),
                from: "running"
            });
            if (done) await enqueue(run.id, core.successors(graph, node.id, port), lane);
            return;
        }
        await finishStep(step.id, {
            status: refused ? "refused" : code === "timeout" ? "timedOut" : "failed",
            error: code,
            output,
            input: store(input),
            from: "running"
        });
        await failLane(run, graph, lane, refused ? "refused" : "failed", code);
    }
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

/** End a lane early: what was still to do in it is skipped. */
async function failLane(
    run: RunRow,
    graph: core.AutomationGraph,
    lane: string,
    outcome: core.RunStatus,
    error: string
): Promise<void> {
    await prisma.automationStep.updateMany({
        where: { runId: run.id, iteration: lane, status: { in: ["ready", "waiting"] } },
        data: { status: "skipped", finishedAt: new Date() }
    });
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

async function endLane(
    run: RunRow,
    graph: core.AutomationGraph,
    lane: string,
    steps: readonly { status: string; port: string | null }[]
): Promise<void> {
    if (lane === FINALLY) {
        const failed = steps.some(
            (step) =>
                ["failed", "refused", "timedOut", "interrupted"].includes(step.status) && !step.port
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
    await prisma.automationRun.updateMany({
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
    const promoted = await promoteQueued(run.automationId);
    if (promoted)
        void advanceRun(promoted).catch((caught) =>
            console.error("polaris: a queued automation run failed to start:", caught)
        );
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------

/** Finish every wait that is due and put its run back to work. Returns the runs to step. */
export async function resumeDueWaits(limit = 100): Promise<string[]> {
    const due = await prisma.automationStep.findMany({
        where: { status: "waiting", waitUntil: { lte: new Date() } },
        orderBy: { waitUntil: "asc" },
        take: limit,
        select: { id: true, runId: true, nodeId: true, iteration: true, waitUntil: true }
    });
    const runs = new Set<string>();
    for (const step of due) {
        const run = await prisma.automationRun.findUnique({
            where: { id: step.runId },
            select: { versionId: true }
        });
        const graph = run ? await loadGraph(run.versionId) : null;
        const done = await finishStep(step.id, {
            status: "ok",
            port: "next",
            output: { waitedUntil: step.waitUntil?.toISOString() ?? null },
            from: "waiting"
        });
        if (!done) continue;
        if (graph)
            await enqueue(step.runId, core.successors(graph, step.nodeId, "next"), step.iteration);
        await prisma.automationRun.updateMany({
            where: { id: step.runId, status: "waiting" },
            data: { status: "running", dueAt: null }
        });
        runs.add(step.runId);
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
