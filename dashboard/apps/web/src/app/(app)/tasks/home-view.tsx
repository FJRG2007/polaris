"use client";

/**
 * Home: what this person has to do, not what the workspace contains.
 *
 * Work is grouped by when it is due rather than by which list it came from,
 * because "what should I do now" is a question about time. Overdue is first and
 * loud; everything with no date at all is last and quiet, which is the right
 * order for a screen somebody opens at nine in the morning.
 */

import Link from "next/link";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { TaskPanel } from "./task-panel";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { Card, CardBody, cn } from "@polaris/ui";
import type { RunningTimer } from "@/lib/tasks/time-service";
import { useDisplayFormat } from "@/components/display-format";
import { CircleAlert, Clock, ListChecks, Play, Square } from "lucide-react";
import { toFacts, type SpaceContext, type TaskRow } from "@/lib/tasks/facts";
import { AvatarStack, CompleteToggle, DueBadge, PriorityFlag, StatusDot } from "./pickers";

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
    const [error, setError] = useState("");

    const groups = useMemo(() => {
        const now = new Date();
        const buckets = new Map<core.DueBucket, TaskRow[]>();
        for (const task of tasks) {
            const bucket = core.dueBucket(toFacts(task), now);
            const existing = buckets.get(bucket);
            if (existing) existing.push(task);
            else buckets.set(bucket, [task]);
        }
        return core.DUE_BUCKETS.map((bucket) => ({ bucket, tasks: buckets.get(bucket) ?? [] })).filter(
            (group) => group.tasks.length > 0
        );
    }, [tasks]);

    // The panel belongs to the space of whatever task is open.
    const openSpaceId = tasks.find((task) => task.id === openTaskId)?.spaceId;
    const openContext = openSpaceId ? contexts[openSpaceId] : undefined;

    const complete = async (task: TaskRow) => {
        const done = contexts[task.spaceId]?.statuses.find((status) => status.type === "done");
        if (!done) {
            setError("That space has no done status yet.");
            return;
        }
        await runAction(() => actions.updateTaskAction({ taskId: task.id, statusId: done.id }), setError);
        router.refresh();
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
                                router.refresh();
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
                        {group.tasks.map((task) => (
                            <li key={task.id} className="flex items-center gap-2 px-3 py-2">
                                <CompleteToggle statusType={task.statusType} onToggle={() => void complete(task)} />
                                <button
                                    type="button"
                                    onClick={() => setOpenTaskId(task.id)}
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                >
                                    <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
                                        {task.reference}
                                    </span>
                                    <span className="truncate text-sm">{task.name}</span>
                                    <PriorityFlag priority={task.priority} />
                                </button>
                                <Link
                                    href={`/tasks/l/${task.listId}`}
                                    className="hidden max-w-32 truncate text-xs text-muted-foreground hover:text-foreground hover:underline md:block"
                                >
                                    {task.listName}
                                </Link>
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
                        ))}
                    </ul>
                </section>
            ))}

            {openContext && (
            <TaskPanel
                taskId={openTaskId}
                context={openContext}
                onClose={() => setOpenTaskId(null)}
                onChanged={() => router.refresh()}
            />
            )}
        </div>
    );
}
