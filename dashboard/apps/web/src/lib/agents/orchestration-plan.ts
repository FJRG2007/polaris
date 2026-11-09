/**
 * The rules of an orchestration run, without a database.
 *
 * Modelled on Orca's orchestration: a Run is a namespace and an inbox, a Task
 * has a spec, the tasks it depends on and a status, a dispatch is one attempt of
 * a task in a session, workers report `worker_done` / `question` /
 * `escalation`, and a decision gate holds a task until somebody answers it.
 * Here the dispatch is an agent session, and the gate is answered by a person on
 * the run's page rather than by the coordinator - a coordinator approving its
 * own plan is not a gate.
 *
 * Everything here is a pure function so the graph can be asserted in a test:
 * which tasks may start, which are blocked and why, and what a new task may ask
 * for under the run's bounds.
 */

export const TASK_STATUSES = [
    "pending",
    "ready",
    "dispatched",
    "completed",
    "failed",
    "blocked"
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** What a blocked task waits on. */
export type BlockedBy = "gate" | "dependency";

/** The bounds a run is created with. Defaults in code, never a setting nobody
 *  wrote: a coordinator that loops must hit these, not a machine's limits. */
export const RUN_BOUNDS = {
    maxTasks: 20,
    maxDepth: 4,
    maxConcurrent: 3,
    /** The most agents one task may be fanned out to. */
    maxVariants: 4,
    /** Runs one account may have going at once. */
    maxActiveRuns: 5
} as const;

/** A gate's answer that stops the task instead of letting it start. */
export const GATE_REJECT = "reject";

export interface PlanTask {
    readonly id: string;
    readonly status: TaskStatus;
    readonly blockedBy: BlockedBy | null;
    readonly dependsOn: readonly string[];
    readonly depth: number;
    readonly gateQuestion: string | null;
    readonly gateResolution: string | null;
    readonly createdAt: Date;
}

/** A status change the graph calls for. */
export interface StatusChange {
    readonly id: string;
    readonly status: TaskStatus;
    readonly blockedBy: BlockedBy | null;
    readonly outcome?: string;
}

function isSettled(status: TaskStatus): boolean {
    return status === "completed" || status === "failed" || status === "dispatched";
}

/**
 * Where each task that has not started should now stand.
 *
 * A task whose dependency failed (or is itself blocked by one) is blocked for
 * good; one whose dependencies all completed is ready, unless it has a gate
 * nobody has answered, or its gate was answered with a rejection, which fails
 * it. Anything else stays pending. Only tasks whose status actually changes are
 * returned, so applying this twice is a no-op.
 */
export function resolveStatuses(tasks: readonly PlanTask[]): StatusChange[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const next = new Map<string, StatusChange>();
    // Depth order, so a dependency's new status is known before its dependents.
    const ordered = [...tasks].sort(
        (a, b) => a.depth - b.depth || a.createdAt.getTime() - b.createdAt.getTime()
    );
    const statusOf = (id: string): { status: TaskStatus; blockedBy: BlockedBy | null } | null => {
        const changed = next.get(id);
        if (changed) return changed;
        const task = byId.get(id);
        return task ? { status: task.status, blockedBy: task.blockedBy } : null;
    };
    for (const task of ordered) {
        if (isSettled(task.status)) continue;
        const deps = task.dependsOn.map(statusOf);
        let change: StatusChange;
        const brokenDep = deps.some(
            (dep) =>
                dep === null ||
                dep.status === "failed" ||
                (dep.status === "blocked" && dep.blockedBy !== "gate")
        );
        if (brokenDep) {
            change = { id: task.id, status: "blocked", blockedBy: "dependency" };
        } else if (deps.every((dep) => dep?.status === "completed")) {
            if (task.gateQuestion && !task.gateResolution) {
                change = { id: task.id, status: "blocked", blockedBy: "gate" };
            } else if (task.gateResolution === GATE_REJECT) {
                change = { id: task.id, status: "failed", blockedBy: null, outcome: "rejected" };
            } else {
                change = { id: task.id, status: "ready", blockedBy: null };
            }
        } else {
            change = { id: task.id, status: "pending", blockedBy: null };
        }
        if (change.status !== task.status || change.blockedBy !== task.blockedBy) {
            next.set(task.id, change);
        }
    }
    return [...next.values()];
}

/** Which ready tasks to dispatch now, oldest first, within the run's
 *  concurrency. */
export function toDispatch(
    tasks: readonly { id: string; status: string; createdAt: Date }[],
    maxConcurrent: number
): string[] {
    const running = tasks.filter((task) => task.status === "dispatched").length;
    const room = Math.max(0, maxConcurrent - running);
    return tasks
        .filter((task) => task.status === "ready")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, room)
        .map((task) => task.id);
}

/** Why a new task may not be added, or its depth. */
export function placeNewTask(
    run: { readonly maxTasks: number; readonly maxDepth: number },
    tasks: readonly Pick<PlanTask, "id" | "depth">[],
    dependsOn: readonly string[],
    adding = 1
): { error: string } | { depth: number } {
    if (tasks.length + adding > run.maxTasks) {
        return {
            error: `This run already has ${tasks.length} tasks, and it was created to hold at most ${run.maxTasks}.`
        };
    }
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const unknown = dependsOn.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
        return { error: `No task in this run with the id ${unknown[0]}.` };
    }
    const depth = dependsOn.reduce((most, id) => Math.max(most, byId.get(id)!.depth + 1), 0);
    if (depth >= run.maxDepth) {
        return {
            error: `That would put the task ${depth + 1} steps down a chain of dependencies, and this run allows ${run.maxDepth}.`
        };
    }
    return { depth };
}

/** Whether every task is finished with, so the run is over. */
export function runIsDone(tasks: readonly Pick<PlanTask, "status" | "blockedBy">[]): boolean {
    return (
        tasks.length > 0 &&
        tasks.every(
            (task) =>
                task.status === "completed" ||
                task.status === "failed" ||
                // A task waiting on a person is not finished with.
                (task.status === "blocked" && task.blockedBy === "dependency")
        )
    );
}

/** What a worker is told before its task, so it knows how to report. */
export function workerPreamble(task: { id: string; title: string; spec: string }): string {
    return [
        `You are a worker in a Polaris orchestration run. Your task: ${task.title} (task id ${task.id}).`,
        "",
        task.spec,
        "",
        "When you are finished, call the Polaris MCP tool orchestration_report exactly once with kind worker_done, outcome succeeded or failed, and a short summary of what you did, what you found and what remains. Report even when you failed.",
        "If you need a decision before you can go on, call orchestration_report with kind question instead of waiting at a prompt; the answer comes back to you as a message.",
        "Use kind escalation for something a person has to see."
    ].join("\n");
}

/** What the coordinator is told when the run starts. */
export function coordinatorPreamble(run: {
    id: string;
    objective: string;
    maxTasks: number;
    maxConcurrent: number;
}): string {
    return [
        `You are the coordinator of a Polaris orchestration run (run id ${run.id}).`,
        "",
        `Objective: ${run.objective}`,
        "",
        "Split it into tasks with orchestration_task_create. Each task becomes its own agent session on its own branch, and starts by itself once the tasks it depends on have completed.",
        "Read what workers report with orchestration_inbox, answer their questions with orchestration_answer, send a worker a follow-up with orchestration_message, and see the whole run with orchestration_tasks.",
        `This run allows ${run.maxTasks} tasks and ${run.maxConcurrent} at once. Do the coordination; leave the implementation to the workers.`,
        "A task with a gate waits for a person to approve it on the run's page."
    ].join("\n");
}

/** One thing in a run waiting on a person, for the needs-you queue. */
export type NeedsYou =
    | { kind: "gate"; runId: string; taskId: string; title: string; question: string }
    | { kind: "question"; runId: string; messageId: string; taskId: string | null; body: string }
    | { kind: "compare"; runId: string; groupId: string; title: string; count: number };

/**
 * What in these runs is waiting on a person: a gate nobody has answered, a
 * question or escalation nobody has answered, and a set of variants that have
 * all finished with none kept yet. Oldest first, so the queue reads in the
 * order things started waiting.
 */
export function needsYou(
    tasks: readonly {
        id: string;
        runId: string;
        title: string;
        status: string;
        blockedBy: string | null;
        gateQuestion: string | null;
        gateResolution: string | null;
        groupId: string | null;
        chosen: boolean;
    }[],
    questions: readonly { id: string; runId: string; taskId: string | null; body: string }[]
): NeedsYou[] {
    const out: NeedsYou[] = [];
    for (const task of tasks) {
        if (task.status === "blocked" && task.blockedBy === "gate" && task.gateResolution === null) {
            out.push({
                kind: "gate",
                runId: task.runId,
                taskId: task.id,
                title: task.title,
                question: task.gateQuestion ?? ""
            });
        }
    }
    for (const question of questions) {
        out.push({
            kind: "question",
            runId: question.runId,
            messageId: question.id,
            taskId: question.taskId,
            body: question.body
        });
    }
    const groups = new Map<string, typeof tasks>();
    for (const task of tasks) {
        if (!task.groupId) continue;
        groups.set(task.groupId, [...(groups.get(task.groupId) ?? []), task]);
    }
    for (const [groupId, variants] of groups) {
        const settled = variants.every((v) => v.status === "completed" || v.status === "failed");
        const anyDone = variants.some((v) => v.status === "completed");
        if (!settled || !anyDone || variants.some((v) => v.chosen)) continue;
        out.push({
            kind: "compare",
            runId: variants[0]!.runId,
            groupId,
            title: variants[0]!.title.replace(/ \([^)]*\)$/, ""),
            count: variants.length
        });
    }
    return out;
}
