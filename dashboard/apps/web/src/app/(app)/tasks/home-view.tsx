"use client";

/**
 * Home: what this person has to do, not what the workspace contains.
 *
 * Work is grouped by when it is due rather than by which list it came from,
 * because "what should I do now" is a question about time. Overdue is first and
 * loud; everything with no date at all is last and quiet, which is the right
 * order for a screen somebody opens at nine in the morning.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { TaskPanel } from "./task-panel";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { TaskEdit } from "./views/shared";
import { Fragment, useMemo, useState } from "react";
import { taskOverlay, type TaskOverlay } from "./optimistic";
import type { RunningTimer } from "@/lib/tasks/time-service";
import { useDisplayFormat } from "@/components/display-format";
import { TaskMenu, type TaskCommands } from "./views/task-actions";
import { Card, CardBody, ConfirmDeleteDialog, cn } from "@polaris/ui";
import { CircleAlert, Clock, ListChecks, Play, Square } from "lucide-react";
import { toFacts, type SpaceContext, type TaskRow } from "@/lib/tasks/facts";
import { AvatarStack, DueBadge, PriorityFlag, StatusDot, StatusMarker, TaskLocation } from "./pickers";

export interface HomeCounts {
    readonly assigned: number;
    readonly overdue: number;
    readonly dueToday: number;
}

function Stat({ label, value, tone, icon: Icon }: { label: string; value: number; tone?: string; icon: typeof Clock }) {
    return (
        <Card>
            <CardBody className="flex items-center gap-3 p-4">
                <Icon className={cn("size-5", tone ?? "text-muted-foreground")} />
                <div>
                    <p className={cn("text-2xl font-semibold leading-none", tone)}>{value}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{label}</p>
                </div>
            </CardBody>
        </Card>
    );
}

export function HomeView({
    tasks,
    counts,
    timer,
    contexts
}: {
    tasks: readonly TaskRow[];
    counts: HomeCounts;
    timer: RunningTimer | null;
    /** One context per space the tasks come from, keyed by space id: home spans
     *  every space, and a task's statuses are its own space's. */
    contexts: Readonly<Record<string, SpaceContext>>;
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const [openTaskId, setOpenTaskId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<TaskRow | null>(null);
    const [error, setError] = useState("");

    // Optimistic overlay: what a menu changed before the server said so. Dropped
    // wholesale on the reload that follows, which is what the server derived from the
    // same change (a completion date, a recurrence) comes back in.
    const [pending, setPending] = useState<Record<string, TaskOverlay>>({});
    const rows = useMemo(() => tasks.map((task) => ({ ...task, ...pending[task.id] })), [tasks, pending]);

    const refresh = () => {
        setPending({});
        router.refresh();
    };

    const groups = useMemo(() => {
        const now = new Date();
        const byId = new Map(rows.map((task) => [task.id, task]));
        const buckets = new Map<core.DueBucket, TaskRow[]>();
        // Soonest first, which is what the screen says it is - and inside a pile
        // where the dates are equal or absent, most urgent first. "No due date"
        // has nothing else to go on, so without this it is in the order the
        // database happened to return.
        for (const facts of core.sortTasks(rows.map(toFacts), { field: "dueDate", direction: "asc" })) {
            const task = byId.get(facts.id);
            if (!task) continue;
            const bucket = core.dueBucket(facts, now, format.weekStartsOn);
            const existing = buckets.get(bucket);
            if (existing) existing.push(task);
            else buckets.set(bucket, [task]);
        }
        return core.DUE_BUCKETS.map((bucket) => ({ bucket, tasks: buckets.get(bucket) ?? [] })).filter(
            (group) => group.tasks.length > 0
        );
    }, [rows, format.weekStartsOn]);

    // The panel belongs to the space of whatever task is open.
    const openSpaceId = rows.find((task) => task.id === openTaskId)?.spaceId;
    const openContext = openSpaceId ? contexts[openSpaceId] : undefined;

    /** A change made from a row's menu, applied here before it is sent so the row
     *  repaints on the click. A refused write reloads and the overlay goes with it. */
    const edit = async (task: TaskRow, change: TaskEdit) => {
        setError("");
        const context = contexts[task.spaceId];
        if (context) {
            setPending((current) => ({
                ...current,
                [task.id]: { ...current[task.id], ...taskOverlay(change, context) }
            }));
        }
        const result = await runAction(() => actions.updateTaskAction({ taskId: task.id, ...change }), setError);
        if (result?.error) setError(result.error);
        refresh();
    };

    /**
     * The same verbs a task offers on a board or in a list. Work reached from
     * here is the work somebody is actually doing today, so reassigning it or
     * moving its date should not cost a trip into the list it came from.
     */
    const commandsFor = (task: TaskRow): TaskCommands | null => {
        const context = contexts[task.spaceId];
        if (!context) return null;
        return {
            task,
            context,
            canEdit: context.canEdit,
            onOpen: () => setOpenTaskId(task.id),
            onEdit: (change) => void edit(task, change),
            onDuplicate: async () => {
                setError("");
                const result = await runAction(() => actions.duplicateTaskAction(task.id), setError);
                if (result?.error) setError(result.error);
                refresh();
            },
            onDelete: () => setDeleting(task)
        };
    };

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-5">
            <div>
                <h1 className="text-xl font-semibold">My work</h1>
                <p className="text-sm text-muted-foreground">Everything assigned to you, soonest first.</p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Assigned to you" value={counts.assigned} icon={ListChecks} />
                <Stat label="Due today" value={counts.dueToday} icon={Clock} tone="text-amber-500" />
                <Stat label="Overdue" value={counts.overdue} icon={CircleAlert} tone="text-destructive" />
            </div>

            {timer && (
                <Card>
                    <CardBody className="flex flex-wrap items-center gap-3 p-4">
                        <Play className="size-4 text-primary" />
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{timer.taskName}</p>
                            <p className="text-xs text-muted-foreground">
                                Running since {format.time(timer.startedAt)} - {core.formatTimer(timer.elapsed)} so far
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={async () => {
                                await runAction(() => actions.stopTimerAction(), setError);
                                refresh();
                            }}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted"
                        >
                            <Square className="size-3.5" /> Stop
                        </button>
                    </CardBody>
                </Card>
            )}

            {error && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </p>
            )}

            {groups.length === 0 && (
                <p className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
                    Nothing is assigned to you. Open a list and put your name on something.
                </p>
            )}

            {groups.map((group) => (
                <section key={group.bucket} className="flex flex-col gap-1">
                    <h2
                        className={cn(
                            "text-sm font-medium",
                            group.bucket === "overdue" && "text-destructive",
                            group.bucket === "today" && "text-amber-500"
                        )}
                    >
                        {core.DUE_BUCKET_LABELS[group.bucket]}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">{group.tasks.length}</span>
                    </h2>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {group.tasks.map((task) => {
                            const commands = commandsFor(task);
                            const row = (
                                <li className="flex items-center gap-2 px-3 py-2">
                                    <StatusMarker
                                        statuses={contexts[task.spaceId]?.statuses ?? []}
                                        statusId={task.statusId}
                                        statusColor={task.statusColor}
                                        statusType={task.statusType}
                                        statusName={task.statusName}
                                        spaceId={task.spaceId}
                                        onChange={(statusId) => void edit(task, { statusId })}
                                    />
                                    {/* Name and where it lives, stacked: this
                                        screen mixes every space the reader can
                                        reach, and a task name on its own does
                                        not say which piece of work it is part
                                        of. The trail stays on a phone, where
                                        knowing that matters just as much. */}
                                    <div className="flex min-w-0 flex-1 flex-col">
                                        <button
                                            type="button"
                                            onClick={() => setOpenTaskId(task.id)}
                                            className="flex min-w-0 items-center gap-2 text-left"
                                        >
                                            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
                                                {task.reference}
                                            </span>
                                            <span className="truncate text-sm">{task.name}</span>
                                            <PriorityFlag priority={task.priority} />
                                        </button>
                                        <TaskLocation task={task} />
                                    </div>
                                    <span className="hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
                                        <StatusDot color={task.statusColor} />
                                        {task.statusName}
                                    </span>
                                    <DueBadge
                                        dueDate={task.dueDate}
                                        statusType={task.statusType}
                                        timed={task.timed}
                                        format={format.date}
                                    />
                                    <AvatarStack people={task.assignees} size={20} />
                                </li>
                            );
                            // Without its space's vocabulary there is nothing to
                            // offer on a right-click, so the row stays a row.
                            return commands ? (
                                <TaskMenu key={task.id} commands={commands}>
                                    {row}
                                </TaskMenu>
                            ) : (
                                <Fragment key={task.id}>{row}</Fragment>
                            );
                        })}
                    </ul>
                </section>
            ))}

            {openContext && (
            <TaskPanel
                taskId={openTaskId}
                context={openContext}
                onClose={() => setOpenTaskId(null)}
                onChanged={() => refresh()}
            />
            )}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                name={deleting?.name ?? ""}
                kind="task"
                requireTyping={false}
                description="Comments, checklists and tracked time go with it. Archiving keeps all of that and takes it off the board."
                confirmLabel="Delete task"
                onConfirm={async () => {
                    if (!deleting) return;
                    const result = await runAction(() => actions.deleteTaskAction(deleting.id), setError);
                    if (result?.error) setError(result.error);
                    setDeleting(null);
                    refresh();
                }}
            />
        </div>
    );
}
