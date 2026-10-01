"use client";

/**
 * Downtime per day, the last 90 days, as a calendar grid: one column a week, one
 * row a weekday, so a bad Tuesday every week reads as a stripe.
 *
 * One hue, four steps a reader can name (under 5 minutes, half an hour, three
 * hours, more), mixed from the theme's danger colour into the card in OKLab so
 * each theme gets its own steps rather than an inverted copy - checked with the
 * palette validator against both card surfaces: monotone, distinct, and the
 * lightest step clear of the surface. A day with no downtime is the muted tone;
 * a day before tracking began has no fill at all, only an edge, so "nothing
 * happened" and "nothing was measured" never look alike.
 *
 * Every day is a button: hover or focus says what it held in the line under the
 * grid, and pressing it filters the list below to that day. The list is also the
 * table view of this chart.
 */

import { cn } from "@polaris/ui";
import { useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { dayStep, type DayDowntime } from "@/lib/connectivity/outages";

/** The four steps, weakest first: share of the danger colour mixed into the card. */
const STEP_MIX = [55, 70, 85, 100] as const;

export function stepColor(step: 1 | 2 | 3 | 4): string {
    return `color-mix(in oklab, hsl(var(--danger)) ${STEP_MIX[step - 1]}%, hsl(var(--card)))`;
}

export function DowntimeHeatmap({
    days,
    since,
    selected,
    onSelect,
    span
}: {
    days: readonly DayDowntime[] | null;
    /** When tracking began, epoch ms; days ending before it were never measured. */
    since: number | null;
    selected: string | null;
    onSelect: (day: DayDowntime | null) => void;
    span: (ms: number) => string;
}) {
    const t = useTranslations("watch");
    const format = useDisplayFormat();
    const [focused, setFocused] = useState<DayDowntime | null>(null);

    if (!days) {
        return <div className="h-[11.5rem] w-full max-w-md animate-pulse rounded-md bg-muted" aria-hidden="true" />;
    }

    const first = days[0];
    // Blank cells before the first day, so each row is one weekday.
    const lead = first ? (new Date(first.start).getDay() - format.weekStartsOn + 7) % 7 : 0;
    const columns = Math.ceil((lead + days.length) / 7);
    const tracked = (day: DayDowntime) => since !== null && day.end > since;
    const describe = (day: DayDowntime) => {
        const date = format.date(day.start);
        if (!tracked(day)) return t("connectivity.days.untracked", { date });
        if (day.downMs <= 0) return t("connectivity.days.clear", { date });
        return t("connectivity.days.cell", { date, duration: span(day.downMs), count: day.count });
    };
    const withDowntime = days.filter((day) => day.downMs > 0).length;

    return (
        <div className="flex flex-col gap-3">
            <div
                role="group"
                aria-label={t("connectivity.days.label", { count: withDowntime })}
                className="grid grid-flow-col grid-rows-7 gap-[3px] self-start"
                style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1.25rem))` }}
            >
                {Array.from({ length: lead }, (_, index) => (
                    <span key={`lead-${index}`} aria-hidden="true" />
                ))}
                {days.map((day) => {
                    const step = dayStep(day.downMs);
                    const measured = tracked(day);
                    const label = describe(day);
                    const active = selected === day.day;
                    return (
                        <button
                            key={day.day}
                            type="button"
                            aria-label={label}
                            aria-pressed={active}
                            title={label}
                            onMouseEnter={() => setFocused(day)}
                            onMouseLeave={() => setFocused(null)}
                            onFocus={() => setFocused(day)}
                            onBlur={() => setFocused(null)}
                            onClick={() => onSelect(active ? null : day)}
                            className={cn(
                                "aspect-square w-full rounded-[3px] transition-shadow",
                                !measured && "border border-dashed border-border bg-transparent",
                                measured && step === 0 && "bg-muted",
                                active && "ring-2 ring-foreground ring-offset-1 ring-offset-card"
                            )}
                            style={measured && step > 0 ? { backgroundColor: stepColor(step as 1 | 2 | 3 | 4) } : undefined}
                        />
                    );
                })}
            </div>
            <p className="min-h-[1.25rem] text-xs text-muted-foreground tabular" aria-live="polite">
                {focused ? describe(focused) : t("connectivity.days.hint")}
            </p>
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                <Legend swatch={<span className="size-3 rounded-[3px] border border-dashed border-border" />}>
                    {t("connectivity.days.legend.untracked")}
                </Legend>
                <Legend swatch={<span className="size-3 rounded-[3px] bg-muted" />}>
                    {t("connectivity.days.legend.none")}
                </Legend>
                {([1, 2, 3, 4] as const).map((step) => (
                    <Legend
                        key={step}
                        swatch={<span className="size-3 rounded-[3px]" style={{ backgroundColor: stepColor(step) }} />}
                    >
                        {t(
                            step === 1
                                ? "connectivity.days.legend.under5m"
                                : step === 2
                                  ? "connectivity.days.legend.under30m"
                                  : step === 3
                                    ? "connectivity.days.legend.under3h"
                                    : "connectivity.days.legend.over3h"
                        )}
                    </Legend>
                ))}
            </ul>
        </div>
    );
}

function Legend({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
    return (
        <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="flex shrink-0">
                {swatch}
            </span>
            {children}
        </li>
    );
}
