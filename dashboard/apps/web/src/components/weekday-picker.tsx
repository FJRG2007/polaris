"use client";

/**
 * A row of weekday toggles over a `getDay()` bitmask, drawn in the reader's own
 * week so Monday-first and Sunday-first both read the way the person expects.
 * Shared by share limits and notification schedules, so a set of days is
 * chosen the same way everywhere.
 */

import { useMemo } from "react";
import * as core from "@polaris/core";
import { cn } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useLocale } from "@/components/i18n/i18n-provider";

export function WeekdayPicker({
    legend,
    days,
    onChange
}: {
    legend: string;
    days: number;
    onChange: (days: number) => void;
}) {
    const locale = useLocale();
    const format = useDisplayFormat();
    const dayNames = useMemo(() => core.weekdayNames(locale, "short"), [locale]);
    const weekOrder = useMemo(() => core.weekOrderFrom(format.weekStartsOn), [format.weekStartsOn]);

    return (
        <fieldset className="flex flex-col gap-1">
            <legend className="text-[12px] text-muted-foreground">{legend}</legend>
            <div className="flex flex-wrap gap-1">
                {weekOrder.map((day: number) => {
                    const on = core.runsOnDay(days, day);
                    return (
                        <button
                            key={day}
                            type="button"
                            aria-pressed={on}
                            onClick={() => onChange(core.toggleDay(days, day))}
                            className={cn(
                                "rounded-md border px-2 py-1 text-[12px]",
                                on
                                    ? "border-primary bg-primary/10 text-foreground"
                                    : "border-border text-muted-foreground"
                            )}
                        >
                            {dayNames[day]}
                        </button>
                    );
                })}
            </div>
        </fieldset>
    );
}
