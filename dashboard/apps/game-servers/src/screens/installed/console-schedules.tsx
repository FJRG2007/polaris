"use client";

/**
 * The console's scheduled commands, under the row of kept ones: what each does,
 * when it runs next, how far a counted one has got, and how the last run went -
 * a skipped run says it was skipped and why, rather than leaving a gap.
 */

import { cn } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { CalendarClock, Square, X } from "lucide-react";
import { type GameText, useGameText, useSchemaText } from "../game-text";
import { isActive, spanOf, type ConsoleSchedule } from "../../lib/console-schedule";

/** A moment in this browser's words, the date left out when it is today. */
function when(iso: string, locale: string): string {
    const at = new Date(iso);
    const today = new Date().toDateString() === at.toDateString();
    return today
        ? at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
        : at.toLocaleString(locale, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit"
          });
}

/** How it repeats, and where it is, in one line. */
export function scheduleSummary(
    t: GameText<"games">,
    schedule: ConsoleSchedule,
    locale: string
): string {
    const repeat = schedule.repeat;
    const parts: string[] = [];
    if (repeat.kind === "once") {
        parts.push(
            t("consoleSchedule.onceAt", {
                time: when(schedule.nextAt ?? schedule.last?.at ?? "", locale)
            })
        );
    } else {
        const gap = spanOf(repeat.minutes);
        parts.push(
            gap.unit === "days"
                ? t("consoleSchedule.everyDays", { count: gap.amount })
                : gap.unit === "hours"
                  ? t("consoleSchedule.everyHours", { count: gap.amount })
                  : t("consoleSchedule.everyMinutes", { count: gap.amount })
        );
        if (repeat.kind === "times") {
            parts.push(t("consoleSchedule.progress", { done: schedule.done, total: repeat.times }));
        }
        if (schedule.nextAt)
            parts.push(t("consoleSchedule.next", { time: when(schedule.nextAt, locale) }));
    }
    if (schedule.skipped > 0)
        parts.push(t("consoleSchedule.skippedCount", { count: schedule.skipped }));
    if (!isActive(schedule)) parts.push(t("consoleSchedule.finished"));
    return parts.join(" - ");
}

export function ConsoleSchedules({
    schedules,
    pending,
    onRemove
}: {
    schedules: readonly ConsoleSchedule[];
    pending: boolean;
    onRemove: (id: string) => void;
}) {
    const t = useGameText("games");
    const schemaText = useSchemaText();
    const locale = hostUi.i18nProvider.useLocale();
    if (schedules.length === 0) return null;
    return (
        <section aria-label={t("consoleSchedule.scheduled")} className="flex flex-col gap-1">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                {t("consoleSchedule.scheduled")}
            </p>
            <ul className="flex flex-col gap-1">
                {schedules.map((schedule) => {
                    const active = isActive(schedule);
                    const last = schedule.last;
                    const label = active
                        ? t("consoleSchedule.stop", { name: schedule.label })
                        : t("consoleSchedule.clear", { name: schedule.label });
                    return (
                        <li
                            key={schedule.id}
                            className={cn(
                                "flex min-w-0 items-start gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-xs",
                                !active && "opacity-70"
                            )}
                        >
                            <CalendarClock
                                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate font-medium" title={schedule.command}>
                                    {schedule.label}
                                </span>
                                <span className="text-muted-foreground">
                                    {scheduleSummary(t, schedule, locale)}
                                </span>
                                {last && (
                                    <span
                                        className={cn(
                                            "break-words",
                                            last.outcome === "failed" && "text-danger",
                                            last.outcome === "skipped" && "text-warning"
                                        )}
                                    >
                                        {last.outcome === "ran"
                                            ? t("consoleSchedule.ran", {
                                                  time: when(last.at, locale)
                                              })
                                            : t(
                                                  last.outcome === "failed"
                                                      ? "consoleSchedule.failed"
                                                      : "consoleSchedule.skipped",
                                                  {
                                                      time: when(last.at, locale),
                                                      detail: schemaText(last.detail) ?? last.detail
                                                  }
                                              )}
                                    </span>
                                )}
                            </div>
                            <button
                                type="button"
                                disabled={pending}
                                onClick={() => onRemove(schedule.id)}
                                aria-label={label}
                                title={label}
                                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                                {active ? (
                                    <Square className="size-3.5" />
                                ) : (
                                    <X className="size-3.5" />
                                )}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
