/**
 * Orchestration runs: a coordinator session plans, worker sessions each take
 * one task, and the graph decides what starts when.
 *
 * The rules are `orchestration-plan`; this applies them to the database and
 * turns a dispatch into a session through the same admission every other start
 * goes through (`session-queue.admitSession`), so a run can never start past the
 * ceilings a person is held to - a dispatch over them queues like any session.
 *
 * Advancing a run is idempotent. A task moves from `ready` to `dispatched` with a
 * conditional update, so the timer and a worker's report arriving together
 * dispatch it once.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as queue from "@/lib/agents/session-queue";
import * as plan from "@/lib/agents/orchestration-plan";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";

/** A refusal whose sentence is meant for whoever asked. */
export class OrchestrationRefusal extends Error {}

export interface RunInput {
    readonly ownerId: string;
    readonly objective: string;
    readonly repoId: string;
    readonly baseRef: string;
    readonly cli: string;
    /** Start a coordinator session to plan it. Off for a run planned by hand. */
    readonly coordinator: boolean;
}

export interface TaskInput {
    readonly title: string;
    readonly spec: string;
    readonly dependsOn: readonly string[];
    readonly cli: string | null;
    readonly gateQuestion: string | null;
}

const TASK_SELECT = {
    id: true,
    title: true,
    spec: true,
    status: true,
    blockedBy: true,
    dependsOn: true,
    depth: true,
    cli: true,
    sessionId: true,
    attempts: true,
    outcome: true,
    result: true,
    groupId: true,
    chosen: true,
    gateQuestion: true,
    gateResolution: true,
    createdAt: true,
    finishedAt: true
} as const;

function asPlanTask(row: {
    id: string;
    status: string;
    blockedBy: string | null;
    dependsOn: string[];
    depth: number;
    gateQuestion: string | null;
    gateResolution: string | null;
    createdAt: Date;
}): plan.PlanTask {
    return {
        id: row.id,
        status: row.status as plan.TaskStatus,
        blockedBy: (row.blockedBy as plan.BlockedBy | null) ?? null,
        dependsOn: row.dependsOn,
        depth: row.depth,
        gateQuestion: row.gateQuestion,
        gateResolution: row.gateResolution,
        createdAt: row.createdAt
    };
}

function sessionInput(
    run: { ownerId: string; repoId: string; baseRef: string; cli: string },
    title: string,
    cli: string | null
): sessions.SessionCreateInput {
    return {
        repoId: run.repoId,
        startedById: run.ownerId,
        title: title.slice(0, 80),
        cli: cli ?? run.cli,
        command: null,
        // A dispatched worker runs where a session started by a model runs: in a
        // container on the Polaris box, with whichever credential resolves. A
        // graph is not the moment to choose somebody's server for them.
        place: "local",
        sharedHome: false,
        unattended: null,
        accountId: null,
        useMachineLogin: false,
        hostId: null,
        baseRef: run.baseRef,
        taskId: null,
        enigma: null
    };
}

/** Create a run, and its coordinator when asked for one. */
export async function createRun(input: RunInput): Promise<{ id: string }> {
    const active = await prisma.agentOrchestrationRun.count({
        where: { ownerId: input.ownerId, status: "active" }
    });
    if (active >= plan.RUN_BOUNDS.maxActiveRuns) {
        throw new OrchestrationRefusal(
            `You already have ${active} runs going, which is as many as one account may have at once. Finish or cancel one first.`
        );
    }
    const run = await prisma.agentOrchestrationRun.create({
        data: {
            ownerId: input.ownerId,
            objective: input.objective,
            repoId: input.repoId,
            baseRef: input.baseRef,
            cli: input.cli,
            maxTasks: plan.RUN_BOUNDS.maxTasks,
            maxDepth: plan.RUN_BOUNDS.maxDepth,
            maxConcurrent: plan.RUN_BOUNDS.maxConcurrent
        }
    });
    if (input.coordinator) {
        const admission = await queue.admitSession(
            sessionInput(run, `Coordinate: ${input.objective}`, null),
            plan.coordinatorPreamble(run)
        );
        await prisma.agentOrchestrationRun.update({
            where: { id: run.id },
            data: { coordinatorSessionId: admission.session.id }
        });
        if (admission.queuedAt === null && !admission.startError) {
            void runtime
                .deliverFirstPrompt(admission.session.id, plan.coordinatorPreamble(run))
                .catch(() => undefined);
        }
    }
    return { id: run.id };
}

/** Add tasks to a run, all or none. A fan-out is several tasks sharing a group. */
export async function addTasks(
    runId: string,
    inputs: readonly TaskInput[],
    groupId: string | null = null
): Promise<string[]> {
    const ids = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            `polaris.agents.orchestration:${runId}`
        );
        const run = await tx.agentOrchestrationRun.findUnique({
            where: { id: runId },
            select: { status: true, maxTasks: true, maxDepth: true }
        });
        if (!run || run.status !== "active") {
            throw new OrchestrationRefusal("That run is not going any more.");
        }
        const tasks = await tx.agentOrchestrationTask.findMany({
            where: { runId },
            select: { id: true, depth: true }
        });
        const created: string[] = [];
        for (const input of inputs) {
            const placed = plan.placeNewTask(run, tasks, input.dependsOn);
            if ("error" in placed) throw new OrchestrationRefusal(placed.error);
            const row = await tx.agentOrchestrationTask.create({
                data: {
                    runId,
                    title: input.title,
                    spec: input.spec,
                    dependsOn: [...input.dependsOn],
                    depth: placed.depth,
                    cli: input.cli,
                    gateQuestion: input.gateQuestion,
                    groupId
                },
                select: { id: true }
            });
            created.push(row.id);
            tasks.push({ id: row.id, depth: placed.depth });
        }
        return created;
    });
    await advanceRun(runId);
    return ids;
}

/**
 * Run one task on several agents at once, to compare what each made of it and
 * keep one (`chooseVariant`). The variants share a group and are otherwise
 * ordinary tasks, so each is its own session on its own branch.
 */
export async function fanOut(
    runId: string,
    input: Omit<TaskInput, "cli">,
    clis: readonly string[]
): Promise<string[]> {
    const distinct = [...new Set(clis)];
    if (distinct.length < 2 || distinct.length > plan.RUN_BOUNDS.maxVariants) {
        throw new OrchestrationRefusal(
            `Pick between 2 and ${plan.RUN_BOUNDS.maxVariants} agents to compare.`
        );
    }
    return addTasks(
        runId,
        distinct.map((cli) => ({ ...input, title: `${input.title} (${cli})`, cli })),
        crypto.randomUUID()
    );
}

/**
 * Move a run on: settle tasks whose session ended without reporting, apply the
 * graph, dispatch what may start, and finish the run when nothing is left.
 */
export async function advanceRun(runId: string): Promise<void> {
    const run = await prisma.agentOrchestrationRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "active") return;
    let tasks = await prisma.agentOrchestrationTask.findMany({
        where: { runId },
        select: TASK_SELECT,
        orderBy: { createdAt: "asc" }
    });

    // A worker whose session ended without saying it was done did not finish.
    const dispatched = tasks.filter((task) => task.status === "dispatched" && task.sessionId);
    if (dispatched.length > 0) {
        const states = await prisma.agentSession.findMany({
            where: { id: { in: dispatched.map((task) => task.sessionId!) } },
            select: { id: true, state: true }
        });
        const over = new Set(
            states
                .filter((row) => core.isSessionOver(row.state as core.AgentSessionState))
                .map((row) => row.id)
        );
        for (const task of dispatched) {
            if (!over.has(task.sessionId!)) continue;
            await prisma.agentOrchestrationTask.updateMany({
                where: { id: task.id, status: "dispatched", sessionId: task.sessionId },
                data: {
                    status: "failed",
                    outcome: "failed",
                    result: "The session ended before it reported.",
                    finishedAt: new Date()
                }
            });
        }
    }

    for (const change of plan.resolveStatuses(tasks.map(asPlanTask))) {
        await prisma.agentOrchestrationTask.updateMany({
            where: { id: change.id, status: { in: ["pending", "ready", "blocked"] } },
            data: {
                status: change.status,
                blockedBy: change.blockedBy,
                ...(change.outcome
                    ? { outcome: change.outcome, result: "Rejected at its gate.", finishedAt: new Date() }
                    : {})
            }
        });
    }

    tasks = await prisma.agentOrchestrationTask.findMany({
        where: { runId },
        select: TASK_SELECT,
        orderBy: { createdAt: "asc" }
    });
    for (const id of plan.toDispatch(tasks, run.maxConcurrent)) {
        await dispatchTask(run, tasks.find((task) => task.id === id)!);
    }

    const coordinatorAlive = run.coordinatorSessionId
        ? await prisma.agentSession.count({
              where: { id: run.coordinatorSessionId, state: { notIn: ["stopped", "failed"] } }
          })
        : 0;
    const latest = await prisma.agentOrchestrationTask.findMany({
        where: { runId },
        select: { status: true, blockedBy: true }
    });
    if (
        coordinatorAlive === 0 &&
        plan.runIsDone(latest.map((task) => ({ status: task.status as plan.TaskStatus, blockedBy: task.blockedBy as plan.BlockedBy | null })))
    ) {
        await prisma.agentOrchestrationRun.updateMany({
            where: { id: runId, status: "active" },
            data: { status: "completed", finishedAt: new Date() }
        });
    }
}

async function dispatchTask(
    run: { id: string; ownerId: string; repoId: string; baseRef: string; cli: string },
    task: { id: string; title: string; spec: string; cli: string | null }
): Promise<void> {
    const claimed = await prisma.agentOrchestrationTask.updateMany({
        where: { id: task.id, status: "ready" },
        data: { status: "dispatched", attempts: { increment: 1 } }
    });
    if (claimed.count !== 1) return;
    const prompt = plan.workerPreamble(task);
    try {
        const admission = await queue.admitSession(sessionInput(run, task.title, task.cli), prompt);
        await prisma.agentOrchestrationTask.update({
            where: { id: task.id },
            data: { sessionId: admission.session.id }
        });
        if (admission.queuedAt === null && !admission.startError) {
            void runtime.deliverFirstPrompt(admission.session.id, prompt).catch(() => undefined);
        }
    } catch (error) {
        await prisma.agentOrchestrationTask.update({
            where: { id: task.id },
            data: {
                status: "failed",
                outcome: "failed",
                result:
                    error instanceof sessions.SessionRefusal
                        ? error.message
                        : "Polaris could not start a session for it.",
                finishedAt: new Date()
            }
        });
    }
}

/** Every active run, moved on. For the timer. */
export async function advanceActiveRuns(): Promise<number> {
    const runs = await prisma.agentOrchestrationRun.findMany({
        where: { status: "active" },
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: 200
    });
    for (const run of runs) await advanceRun(run.id).catch(() => undefined);
    return runs.length;
}

/** What a session is to orchestration: the runs it coordinates and the task it
 *  works on. The MCP endpoint narrows a session's scopes on this. */
export async function sessionRole(
    sessionId: string
): Promise<{ coordinates: boolean; works: boolean }> {
    const [coordinates, works] = await Promise.all([
        prisma.agentOrchestrationRun.count({
            where: { coordinatorSessionId: sessionId, status: "active" }
        }),
        prisma.agentOrchestrationTask.count({
            where: { sessionId, status: "dispatched" }
        })
    ]);
    return { coordinates: coordinates > 0, works: works > 0 };
}

/** The run a caller may coordinate: the one its session coordinates, or, for a
 *  person's own key, a run of theirs named by id. */
export async function runForCoordinator(caller: {
    userId: string;
    sessionId?: string;
    runId?: string;
}): Promise<{ id: string; ownerId: string } | null> {
    if (caller.sessionId) {
        return prisma.agentOrchestrationRun.findFirst({
            where: { coordinatorSessionId: caller.sessionId, ownerId: caller.userId, status: "active" },
            select: { id: true, ownerId: true }
        });
    }
    if (!caller.runId) return null;
    return prisma.agentOrchestrationRun.findFirst({
        where: { id: caller.runId, ownerId: caller.userId, status: "active" },
        select: { id: true, ownerId: true }
    });
}

export type ReportKind = "worker_done" | "question" | "escalation";

/**
 * A worker reporting. Only the session currently dispatched on that task may
 * report on it, so a stale retry cannot complete the wrong attempt.
 */
export async function report(
    sessionId: string,
    taskId: string,
    kind: ReportKind,
    body: string,
    outcome: "succeeded" | "failed" | null
): Promise<void> {
    const task = await prisma.agentOrchestrationTask.findFirst({
        where: { id: taskId, sessionId, status: "dispatched" },
        select: { id: true, runId: true, title: true, run: { select: { coordinatorSessionId: true } } }
    });
    if (!task) {
        throw new OrchestrationRefusal(
            "This session is not working on that task now, so it cannot report on it."
        );
    }
    if (kind === "worker_done") {
        await prisma.agentOrchestrationTask.updateMany({
            where: { id: task.id, sessionId, status: "dispatched" },
            data: {
                status: outcome === "failed" ? "failed" : "completed",
                outcome: outcome ?? "succeeded",
                result: body,
                finishedAt: new Date()
            }
        });
    }
    await prisma.agentOrchestrationMessage.create({
        data: { runId: task.runId, taskId: task.id, fromSession: sessionId, kind, body }
    });
    const coordinator = task.run.coordinatorSessionId;
    if (coordinator) {
        const line =
            kind === "worker_done"
                ? `Task "${task.title}" (${task.id}) finished: ${outcome ?? "succeeded"}. Read it with orchestration_inbox.`
                : `Task "${task.title}" (${task.id}) has a ${kind === "question" ? "question" : "escalation"}. Read it with orchestration_inbox.`;
        await runtime.promptSession(coordinator, line).catch(() => undefined);
    }
    await advanceRun(task.runId);
}

/** Unread mail for a run, marked read. */
export async function readInbox(runId: string, limit = 20) {
    const rows = await prisma.agentOrchestrationMessage.findMany({
        where: { runId, readAt: null },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true, taskId: true, kind: true, body: true, createdAt: true }
    });
    if (rows.length > 0) {
        await prisma.agentOrchestrationMessage.updateMany({
            where: { id: { in: rows.map((row) => row.id) } },
            data: { readAt: new Date() }
        });
    }
    return rows;
}

/** Answer a worker's question or escalation, and hand the answer to the worker. */
export async function answer(runId: string, messageId: string, text: string): Promise<void> {
    const message = await prisma.agentOrchestrationMessage.findFirst({
        where: { id: messageId, runId, kind: { in: ["question", "escalation"] } },
        select: { id: true, fromSession: true, answeredAt: true }
    });
    if (!message) throw new OrchestrationRefusal("No question with that id in this run.");
    if (message.answeredAt) throw new OrchestrationRefusal("That question has been answered.");
    await prisma.agentOrchestrationMessage.update({
        where: { id: message.id },
        data: { answer: text, answeredAt: new Date(), readAt: new Date() }
    });
    if (message.fromSession) await runtime.promptSession(message.fromSession, text);
}

/** Send the worker on a task a follow-up. */
export async function messageWorker(runId: string, taskId: string, text: string): Promise<void> {
    const task = await prisma.agentOrchestrationTask.findFirst({
        where: { id: taskId, runId },
        select: { sessionId: true }
    });
    if (!task?.sessionId) throw new OrchestrationRefusal("That task has no worker yet.");
    const session = await prisma.agentSession.findUnique({
        where: { id: task.sessionId },
        select: { state: true }
    });
    const state = (session?.state ?? "stopped") as core.AgentSessionState;
    if (core.isSessionOver(state)) throw new OrchestrationRefusal("That worker's session has ended.");
    if (core.isSessionQueued(state)) {
        throw new OrchestrationRefusal("That worker is still waiting for a free slot.");
    }
    await runtime.promptSession(task.sessionId, text);
}

/** A person answering a task's gate. */
export async function resolveGate(
    runId: string,
    taskId: string,
    approved: boolean,
    userId: string
): Promise<void> {
    const moved = await prisma.agentOrchestrationTask.updateMany({
        where: { id: taskId, runId, status: "blocked", blockedBy: "gate", gateResolution: null },
        data: {
            gateResolution: approved ? "approve" : plan.GATE_REJECT,
            gateResolvedBy: userId,
            gateResolvedAt: new Date()
        }
    });
    if (moved.count !== 1) throw new OrchestrationRefusal("That task is not waiting on a decision.");
    await advanceRun(runId);
}

/** Keep one variant of a fan-out and stop the others. */
export async function chooseVariant(runId: string, taskId: string): Promise<void> {
    const task = await prisma.agentOrchestrationTask.findFirst({
        where: { id: taskId, runId, groupId: { not: null } },
        select: { groupId: true }
    });
    if (!task?.groupId) throw new OrchestrationRefusal("That task is not one of several variants.");
    const others = await prisma.agentOrchestrationTask.findMany({
        where: { groupId: task.groupId, id: { not: taskId } },
        select: { id: true, sessionId: true, status: true }
    });
    await prisma.$transaction([
        prisma.agentOrchestrationTask.update({ where: { id: taskId }, data: { chosen: true } }),
        prisma.agentOrchestrationTask.updateMany({
            where: { groupId: task.groupId, id: { not: taskId } },
            data: { chosen: false }
        })
    ]);
    for (const other of others) {
        if (!other.sessionId) continue;
        if (!(await queue.cancelQueued(other.sessionId))) {
            await runtime.stopSession(other.sessionId).catch(() => undefined);
        }
    }
    await advanceRun(runId);
}

/** Cancel a run: nothing more is dispatched and its live sessions stop. */
export async function cancelRun(runId: string): Promise<void> {
    const run = await prisma.agentOrchestrationRun.findUnique({
        where: { id: runId },
        select: { coordinatorSessionId: true }
    });
    await prisma.agentOrchestrationRun.updateMany({
        where: { id: runId, status: "active" },
        data: { status: "cancelled", finishedAt: new Date() }
    });
    const tasks = await prisma.agentOrchestrationTask.findMany({
        where: { runId, status: "dispatched" },
        select: { sessionId: true }
    });
    const live = [run?.coordinatorSessionId, ...tasks.map((task) => task.sessionId)].filter(
        (id): id is string => Boolean(id)
    );
    for (const id of live) {
        if (!(await queue.cancelQueued(id))) await runtime.stopSession(id).catch(() => undefined);
    }
    await prisma.agentOrchestrationTask.updateMany({
        where: { runId, status: { in: ["pending", "ready", "blocked", "dispatched"] } },
        data: { status: "failed", outcome: "failed", result: "The run was cancelled.", finishedAt: new Date() }
    });
}

/** The tasks of a run, for a tool or a screen. */
export function runTasks(runId: string) {
    return prisma.agentOrchestrationTask.findMany({
        where: { runId },
        select: TASK_SELECT,
        orderBy: { createdAt: "asc" },
        take: plan.RUN_BOUNDS.maxTasks * plan.RUN_BOUNDS.maxVariants
    });
}
