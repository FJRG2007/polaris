"use client";

/**
 * The reporting screen.
 *
 * Charts are inline SVG rather than a charting dependency: three shapes (a
 * stacked bar, a sparkline, a horizontal bar list) is not worth a library, and
 * they inherit the theme's colours for free this way.
 */

import * as core from "@polaris/core";
import { ProgressBar } from "./pickers";
import { Card, CardBody, cn } from "@polaris/ui";
import type { TaskReport } from "@/lib/tasks/report-service";
import { useDisplayFormat } from "@/components/display-format";
import { CircleAlert, CircleCheck, Clock, ListTodo } from "lucide-react";

function Stat({
    label,
    value,
    hint,
    tone,
    icon: Icon
}: {
    label: string;
    value: string | number;
    hint?: string;
    tone?: string;
    icon: typeof Clock;
}) {
    return (
        <Card>
            <CardBody className="flex items-start gap-3 p-4">
                <Icon className={cn("mt-0.5 size-5", tone ?? "text-muted-foreground")} />
                <div className="min-w-0">
                    <p className={cn("text-2xl font-semibold leading-none", tone)}>{value}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{label}</p>
                    {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
                </div>
            </CardBody>
        </Card>
    );
}

export function ReportsView({
    report,
    timeByPerson
}: {
    report: TaskReport;
    timeByPerson: readonly { userId: string; name: string; seconds: number }[];
}) {
    const format = useDisplayFormat();
    const { summary } = report;
    const totalStatus = report.byStatus.reduce((sum, slice) => sum + slice.count, 0);
    const maxCompleted = Math.max(1, ...report.completion.map((point) => point.completed));

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-5">
            <header>
                <h1 className="text-xl font-semibold">Reporting</h1>
                <p className="text-sm text-muted-foreground">
                    Across every space you can see. Archived work is left out of all of it.
                </p>
            </header>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Open tasks" value={summary.open} icon={ListTodo} />
                <Stat label="Overdue" value={summary.overdue} tone="text-destructive" icon={CircleAlert} />
                <Stat
                    label="Completed this week"
                    value={summary.completedThisWeek}
                    tone="text-emerald-500"
                    icon={CircleCheck}
                />
                <Stat
                    label="Tracked this week"
                    value={core.formatTrackedSeconds(summary.trackedThisWeek)}
                    hint={`${summary.dueThisWeek} due this week`}
                    icon={Clock}
                />
            </div>

            <Card>
                <CardBody className="flex flex-col gap-3 p-4">
                    <h2 className="text-sm font-medium">By status</h2>
                    {totalStatus === 0 ? (
                        <p className="text-xs text-muted-foreground">No tasks yet.</p>
                    ) : (
                        <>
                            <div className="flex h-3 w-full overflow-hidden rounded-full">
                                {report.byStatus.map((slice) => (
                                    <span
                                        key={slice.id}
                                        title={`${slice.name}: ${slice.count}`}
                                        style={{
                                            width: `${(slice.count / totalStatus) * 100}%`,
                                            backgroundColor: slice.color
                                        }}
                                    />
                                ))}
                            </div>
                            <ul className="flex flex-wrap gap-x-4 gap-y-1">
                                {report.byStatus.map((slice) => (
                                    <li key={slice.id} className="flex items-center gap-1.5 text-xs">
                                        <span
                                            aria-hidden
                                            className="size-2.5 rounded-full"
                                            style={{ backgroundColor: slice.color }}
                                        />
                                        {slice.name}
                                        <span className="text-muted-foreground">{slice.count}</span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </CardBody>
            </Card>

            <div className="grid gap-3 lg:grid-cols-2">
                <Card>
                    <CardBody className="flex flex-col gap-3 p-4">
                        <h2 className="text-sm font-medium">Completed, last 30 days</h2>
                        <svg viewBox="0 0 300 60" preserveAspectRatio="none" className="h-20 w-full" role="img" aria-label="Tasks completed per day">
                            {report.completion.map((point, index) => (
                                <rect
                                    key={point.date}
                                    x={index * 10}
                                    y={60 - (point.completed / maxCompleted) * 60}
                                    width={8}
                                    height={Math.max(1, (point.completed / maxCompleted) * 60)}
                                    className="fill-primary/70"
                                >
                                    <title>
                                        {format.date(point.date)}: {point.completed}
                                    </title>
                                </rect>
                            ))}
                        </svg>
                        <p className="text-xs text-muted-foreground">
                            {report.completion.reduce((sum, point) => sum + point.completed, 0)} finished in the last
                            month.
                        </p>
                    </CardBody>
                </Card>

                <Card>
                    <CardBody className="flex flex-col gap-3 p-4">
                        <h2 className="text-sm font-medium">Open work by priority</h2>
                        <ul className="flex flex-col gap-2">
                            {report.byPriority.map((slice) => (
                                <li key={slice.priority} className="flex items-center gap-2 text-xs">
                                    <span className="w-20 shrink-0">{core.TASK_PRIORITY_LABELS[slice.priority]}</span>
                                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                        <span
                                            className="block h-full rounded-full"
                                            style={{
                                                width: `${(slice.count / Math.max(1, summary.open)) * 100}%`,
                                                backgroundColor: core.TASK_PRIORITY_COLORS[slice.priority]
                                            }}
                                        />
                                    </div>
                                    <span className="w-8 text-right text-muted-foreground">{slice.count}</span>
                                </li>
                            ))}
                            {report.byPriority.length === 0 && (
                                <li className="text-xs text-muted-foreground">Nothing open.</li>
                            )}
                        </ul>
                    </CardBody>
                </Card>
            </div>

            <Card>
                <CardBody className="flex flex-col gap-3 p-4">
                    <h2 className="text-sm font-medium">Who is carrying what</h2>
                    <ul className="flex flex-col gap-2">
                        {report.load.map((person) => (
                            <li key={person.userId} className="flex flex-wrap items-center gap-3 text-xs">
                                <span className="w-36 shrink-0 truncate">{person.name}</span>
                                <div className="min-w-32 flex-1">
                                    <ProgressBar
                                        percent={(person.open / Math.max(1, report.load[0]?.open ?? 1)) * 100}
                                    />
                                </div>
                                <span className="text-muted-foreground">{person.open} open</span>
                                {person.overdue > 0 && <span className="text-destructive">{person.overdue} overdue</span>}
                                {person.points > 0 && <span className="text-muted-foreground">{person.points} pts</span>}
                            </li>
                        ))}
                        {report.load.length === 0 && (
                            <li className="text-xs text-muted-foreground">Nothing is assigned to anybody yet.</li>
                        )}
                    </ul>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3 p-4">
                    <h2 className="text-sm font-medium">Time tracked this week</h2>
                    <ul className="flex flex-col gap-2">
                        {timeByPerson.map((person) => (
                            <li key={person.userId} className="flex items-center gap-3 text-xs">
                                <span className="w-36 shrink-0 truncate">{person.name}</span>
                                <div className="min-w-32 flex-1">
                                    <ProgressBar
                                        percent={(person.seconds / Math.max(1, timeByPerson[0]?.seconds ?? 1)) * 100}
                                    />
                                </div>
                                <span className="text-muted-foreground">
                                    {core.formatTrackedSeconds(person.seconds)}
                                </span>
                            </li>
                        ))}
                        {timeByPerson.length === 0 && (
                            <li className="text-xs text-muted-foreground">No time tracked this week.</li>
                        )}
                    </ul>
                </CardBody>
            </Card>
        </div>
    );
}
