"use client";

/**
 * A small month to jump with: the sidebar's, and the header's date picker.
 * Arrow keys move the day, Page Up/Down the month, Enter opens it.
 */

import * as time from "./time";
import { useCalendarT } from "./i18n";
import { Button, cn } from "@polaris/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export function MiniMonth({
    value,
    today,
    firstDay,
    locale,
    highlight,
    onPick,
    autoFocus
}: {
    /** The day shown as chosen. */
    value: string;
    today: string;
    firstDay: number;
    locale: string;
    /** The days the calendar is showing, drawn as a band. */
    highlight: time.DayWindow | null;
    onPick: (day: string) => void;
    autoFocus?: boolean;
}) {
    const t = useCalendarT();
    const [month, setMonth] = useState(() => time.firstOfMonth(value));
    const [focus, setFocus] = useState(value);
    const grid = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setMonth(time.firstOfMonth(value));
        setFocus(value);
    }, [value]);

    useEffect(() => {
        if (!autoFocus) return;
        const timer = setTimeout(() => grid.current?.querySelector<HTMLButtonElement>("[data-focus='true']")?.focus(), 0);
        return () => clearTimeout(timer);
    }, [autoFocus]);

    const moveFocus = (day: string) => {
        setFocus(day);
        if (time.firstOfMonth(day) !== month) setMonth(time.firstOfMonth(day));
        setTimeout(() => grid.current?.querySelector<HTMLButtonElement>(`[data-day='${day}']`)?.focus(), 0);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const steps: Record<string, () => string> = {
            ArrowLeft: () => time.addDays(focus, -1),
            ArrowRight: () => time.addDays(focus, 1),
            ArrowUp: () => time.addDays(focus, -7),
            ArrowDown: () => time.addDays(focus, 7),
            PageUp: () => time.addMonths(focus, -1),
            PageDown: () => time.addMonths(focus, 1),
            Home: () => time.weekStartOf(focus, firstDay),
            End: () => time.addDays(time.weekStartOf(focus, firstDay), 6)
        };
        const step = steps[event.key];
        if (!step) return;
        event.preventDefault();
        event.stopPropagation();
        moveFocus(step());
    };

    const weeks = time.monthGrid(month, firstDay);
    const names = time.weekdayLabels(locale, firstDay, "narrow");
    const longNames = time.weekdayLabels(locale, firstDay, "long");
    const title = time.formatDay(month, locale, { month: "long", year: "numeric" });

    return (
        <div className="flex flex-col gap-1 select-none">
            <div className="flex items-center gap-1">
                <p className="min-w-0 flex-1 truncate px-1 text-[0.8125rem] font-medium first-letter:uppercase" aria-live="polite">
                    {title}
                </p>
                <Button size="icon-xs" variant="ghost" aria-label={t("header.previousMonth")} title={t("header.previousMonth")} onClick={() => setMonth(time.addMonths(month, -1))}>
                    <ChevronLeft />
                </Button>
                <Button size="icon-xs" variant="ghost" aria-label={t("header.nextMonth")} title={t("header.nextMonth")} onClick={() => setMonth(time.addMonths(month, 1))}>
                    <ChevronRight />
                </Button>
            </div>
            <div ref={grid} role="grid" aria-label={title} onKeyDown={onKeyDown} className="grid grid-cols-7 text-center text-[11px] tabular-nums">
                <div role="row" className="contents">
                    {names.map((name, index) => (
                        <span key={index} role="columnheader" aria-label={longNames[index]} className="py-1 text-foreground-subtle">
                            {name}
                        </span>
                    ))}
                </div>
                {weeks.map((week) => (
                    <div role="row" key={week[0]} className="contents">
                        {week.map((day) => {
                            const inMonth = day.slice(0, 7) === month.slice(0, 7);
                            const inWindow = highlight !== null && day >= highlight.start && day < highlight.end;
                            return (
                                <span role="gridcell" key={day} className={cn("p-px", inWindow && "bg-muted")}>
                                    <button
                                        type="button"
                                        data-day={day}
                                        data-focus={day === focus}
                                        tabIndex={day === focus ? 0 : -1}
                                        aria-current={day === today ? "date" : undefined}
                                        aria-selected={day === value}
                                        aria-label={time.formatDay(day, locale, { dateStyle: "full" })}
                                        onClick={() => onPick(day)}
                                        className={cn(
                                            "flex h-6 w-full items-center justify-center rounded transition-colors duration-fast hover:bg-card-hover",
                                            !inMonth && "text-foreground-subtle",
                                            day === today && "font-semibold text-foreground underline decoration-2 underline-offset-2",
                                            day === value && "bg-foreground text-background hover:bg-foreground"
                                        )}
                                    >
                                        {Number(day.slice(8))}
                                    </button>
                                </span>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}
