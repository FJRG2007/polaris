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
import { optionLabel } from "./option-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PersonName, PersonRow } from "@/components/person-name";
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
                    {hint && <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{hint}</p>}
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
    const t = useTranslations("tasks");
    const { summary } = report;
    const totalStatus = report.byStatus.reduce((sum, slice) => sum + slice.count, 0);
    const maxCompleted = Math.max(1, ...report.completion.map((point) => point.completed));

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-5">
            <header>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("reports.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("reports.subtitle")}</p>
            </header>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label={t("reports.open")} value={summary.open} icon={ListTodo} />
                <Stat label={t("home.overdue")} value={summary.overdue} tone="text-danger" icon={CircleAlert} />
                <Stat
                    label={t("reports.completedThisWeek")}
                    value={summary.completedThisWeek}
                    tone="text-success"
                    icon={CircleCheck}
                />
                <Stat
                    label={t("timesheet.trackedThisWeek")}
                    value={core.formatTrackedSeconds(summary.trackedThisWeek)}
                    hint={t("reports.dueThisWeek", { count: summary.dueThisWeek })}
                    icon={Clock}
                />
            </div>

            <Card>
                <CardBody className="flex flex-col gap-3 p-4">
                    <h2 className="text-sm font-medium">{t("reports.byStatus")}</h2>
                    {totalStatus === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("reports.noTasks")}</p>
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
                        <h2 className="text-sm font-medium">{t("reports.completed30")}</h2>
                        <svg viewBox="0 0 300 60" preserveAspectRatio="none" className="h-20 w-full" role="img" aria-label={t("reports.perDay")}>
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
                            {t("reports.finishedLastMonth", {
                                count: report.completion.reduce((sum, point) => sum + point.completed, 0)
                            })}
                        </p>
                    </CardBody>
                </Card>

                <Card>
                    <CardBody className="flex flex-col gap-3 p-4">
                        <h2 className="text-sm font-medium">{t("reports.byPriority")}</h2>
                        <ul className="flex flex-col gap-2">
                            {report.byPriority.map((slice) => (
                                <li key={slice.priority} className="flex items-center gap-2 text-xs">
                                    <span className="w-20 shrink-0">{optionLabel(t, "priority", slice.priority)}</span>
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
                                <li className="text-xs text-muted-foreground">{t("reports.nothingOpen")}</li>
                            )}
                        </ul>
                    </CardBody>
                </Card>
            </div>

            <Card>
                <CardBody className="flex flex-col gap-3 p-4">
                    <h2 className="text-sm font-medium">{t("reports.load")}</h2>
                    <ul className="flex flex-col gap-2">
                        {report.load.map((person) => (
                            <PersonRow
                                as="li"
                                key={person.userId}
                                personId={person.userId}
                                className="-mx-2 flex flex-wrap items-center gap-3 rounded-md px-2 py-0.5 text-xs"
                            >
                                <span className="w-36 shrink-0 truncate">
                                    <PersonName id={person.userId} name={person.name} />
                                </span>
                                <div className="min-w-32 flex-1">
                                    <ProgressBar
                                        percent={(person.open / Math.max(1, report.load[0]?.open ?? 1)) * 100}
                                    />
                                </div>
                                <span className="text-muted-foreground">{t("reports.openCount", { count: person.open })}</span>
                                {person.overdue > 0 && (
                                    <span className="text-danger">{t("reports.overdueCount", { count: person.overdue })}</span>
                                )}
                                {person.points > 0 && (
                                    <span className="text-muted-foreground">{t("reports.points", { count: person.points })}</span>
                                )}
                            </PersonRow>
                        ))}
                        {report.load.length === 0 && (
                            <li className="text-xs text-muted-foreground">{t("reports.noLoad")}</li>
                        )}
                    </ul>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3 p-4">
                    <h2 className="text-sm font-medium">{t("reports.timeThisWeek")}</h2>
                    <ul className="flex flex-col gap-2">
                        {timeByPerson.map((person) => (
                            <PersonRow
                                as="li"
                                key={person.userId}
                                personId={person.userId}
                                className="-mx-2 flex items-center gap-3 rounded-md px-2 py-0.5 text-xs"
                            >
                                <span className="w-36 shrink-0 truncate">
                                    <PersonName id={person.userId} name={person.name} />
                                </span>
                                <div className="min-w-32 flex-1">
                                    <ProgressBar
                                        percent={(person.seconds / Math.max(1, timeByPerson[0]?.seconds ?? 1)) * 100}
                                    />
                                </div>
                                <span className="text-muted-foreground">
                                    {core.formatTrackedSeconds(person.seconds)}
                                </span>
                            </PersonRow>
                        ))}
                        {timeByPerson.length === 0 && (
                            <li className="text-xs text-muted-foreground">{t("reports.noTime")}</li>
                        )}
                    </ul>
                </CardBody>
            </Card>
        </div>
    );
}
