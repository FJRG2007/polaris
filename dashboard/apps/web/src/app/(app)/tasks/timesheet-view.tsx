"use client";

/**
 * A week of tracked time as a grid: tasks down, days across.
 *
 * Billable and unbillable time on the same task are separate rows rather than
 * one total, because an invoice cannot use a number that mixes them.
 */

import Link from "next/link";
import { useState } from "react";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { Card, CardBody, cn } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { ChevronLeft, ChevronRight, Square } from "lucide-react";
import type { RunningTimer, Timesheet } from "@/lib/tasks/time-service";

/** The seven columns, named off the week the sheet actually covers rather than
 *  from a fixed list - the week starts on whichever day the account chose, and a
 *  header that disagrees with the columns under it is worse than none. */
function weekdayHeadings(from: string, locale: string): string[] {
    const first = new Date(from);
    const names = core.weekdayNames(locale, "short");
    return Array.from({ length: 7 }, (_, offset) => names[core.addDays(first, offset).getDay()] as string);
}

export function TimesheetView({
    sheet,
    timer,
    weekOffset
}: {
    sheet: Timesheet;
    timer: RunningTimer | null;
    weekOffset: number;
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const locale = useLocale();
    const t = useTranslations("tasks");
    const [error, setError] = useState("");

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-4">
            <header className="flex flex-wrap items-center gap-3">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("timesheet.title")}</h1>
                    <p className="text-sm text-muted-foreground">
                        {t("timesheet.range", { from: format.date(sheet.from), to: format.date(sheet.to) })}
                    </p>
                </div>
                <span className="flex-1" />
                <div className="flex items-center gap-1">
                    <Link
                        href={`/tasks/time?week=${weekOffset - 1}`}
                        aria-label={t("timesheet.previousWeek")}
                        className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ChevronLeft className="size-4" />
                    </Link>
                    {weekOffset !== 0 && (
                        <Link
                            href="/tasks/time"
                            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            {t("timesheet.thisWeek")}
                        </Link>
                    )}
                    <Link
                        href={`/tasks/time?week=${weekOffset + 1}`}
                        aria-label={t("timesheet.nextWeek")}
                        className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ChevronRight className="size-4" />
                    </Link>
                </div>
            </header>

            {timer && (
                <Card>
                    <CardBody className="flex flex-wrap items-center gap-3 p-3">
                        <span className="size-2 animate-pulse rounded-full bg-primary" />
                        <Link href={`/tasks/t/${timer.taskId}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                            {timer.taskName}
                        </Link>
                        <span className="font-mono text-sm">{core.formatTimer(timer.elapsed)}</span>
                        <button
                            type="button"
                            onClick={async () => {
                                await runAction(() => actions.stopTimerAction(), setError);
                                router.refresh();
                            }}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted"
                        >
                            <Square className="size-3.5" /> {t("timesheet.stop")}
                        </button>
                    </CardBody>
                </Card>
            )}

            {error && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Card>
                    <CardBody className="p-4">
                        <p className="text-2xl font-semibold leading-none">{core.formatTrackedSeconds(sheet.total)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{t("timesheet.trackedThisWeek")}</p>
                    </CardBody>
                </Card>
                <Card>
                    <CardBody className="p-4">
                        <p className="text-2xl font-semibold leading-none text-success">
                            {core.formatTrackedSeconds(sheet.billable)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">{t("timesheet.billable")}</p>
                    </CardBody>
                </Card>
                <Card>
                    <CardBody className="p-4">
                        <p className="text-2xl font-semibold leading-none">{sheet.entries.length}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{t("timesheet.tasksWorkedOn")}</p>
                    </CardBody>
                </Card>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[44rem] border-collapse text-sm">
                    <thead>
                        <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                            <th className="px-3 py-2 font-medium">{t("timesheet.task")}</th>
                            {weekdayHeadings(sheet.from, locale).map((day, index) => (
                                <th key={`${day}-${index}`} className="px-2 py-2 text-center font-medium">
                                    {day}
                                </th>
                            ))}
                            <th className="px-3 py-2 text-right font-medium">{t("timesheet.total")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sheet.entries.map((entry) => (
                            <tr key={`${entry.taskId}-${entry.billable}`} className="border-b border-border">
                                <td className="max-w-xs px-3 py-2">
                                    <Link href={`/tasks/t/${entry.taskId}`} className="flex items-center gap-2 hover:underline">
                                        <span className="font-mono text-[0.6875rem] text-muted-foreground">
                                            {entry.reference}
                                        </span>
                                        <span className="truncate">{entry.taskName}</span>
                                        {entry.billable && (
                                            <span className="shrink-0 text-[0.625rem] text-success">{t("timesheet.billableTag")}</span>
                                        )}
                                    </Link>
                                    <p className="truncate text-[0.6875rem] text-muted-foreground">
                                        {entry.spaceName} / {entry.listName}
                                    </p>
                                </td>
                                {entry.days.map((seconds, index) => (
                                    <td
                                        key={index}
                                        className={cn(
                                            "px-2 py-2 text-center text-xs",
                                            seconds === 0 && "text-muted-foreground/40"
                                        )}
                                    >
                                        {seconds > 0 ? core.formatTrackedSeconds(seconds) : "-"}
                                    </td>
                                ))}
                                <td className="px-3 py-2 text-right font-medium">
                                    {core.formatTrackedSeconds(entry.total)}
                                </td>
                            </tr>
                        ))}
                        {sheet.entries.length === 0 && (
                            <tr>
                                <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                                    {t("timesheet.empty")}
                                </td>
                            </tr>
                        )}
                    </tbody>
                    {sheet.entries.length > 0 && (
                        <tfoot>
                            <tr className="bg-muted/40 text-xs font-medium">
                                <td className="px-3 py-2">{t("timesheet.total")}</td>
                                {sheet.dayTotals.map((seconds, index) => (
                                    <td key={index} className="px-2 py-2 text-center">
                                        {seconds > 0 ? core.formatTrackedSeconds(seconds) : "-"}
                                    </td>
                                ))}
                                <td className="px-3 py-2 text-right">{core.formatTrackedSeconds(sheet.total)}</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </div>
    );
}
