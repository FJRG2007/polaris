"use client";

/**
 * A date, date-and-time or time field drawn in the design system instead of the
 * browser's own control, which looks different in every browser and ignores the
 * dark theme.
 *
 * The value is the same string the native input would hold - `YYYY-MM-DD`,
 * `YYYY-MM-DDTHH:mm`, `HH:mm` - so a field can be swapped in without touching
 * what reads it, and a form posts it under its `name` like the native one did.
 * The calendar opens in a portal, flips and shifts to stay on screen, and is
 * driven from the keyboard: arrows move a day or a week, Page Up/Down a month,
 * Home/End the start or end of the week, Enter picks.
 *
 * `onChange` receives `{ target: { value, name } }`, the part of a change event
 * every caller reads, so `(event) => set(event.target.value)` keeps working.
 */

import { cn } from "../lib/cn";
import * as Popover from "@radix-ui/react-popover";
import { useLocale, useTranslations } from "../i18n";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

export type DateInputMode = "date" | "datetime" | "time";

export interface DateInputChange {
    target: { value: string; name: string };
    currentTarget: { value: string; name: string };
}

export interface DateInputProps {
    mode?: DateInputMode;
    value?: string;
    defaultValue?: string;
    onChange?: (event: DateInputChange) => void;
    onValueChange?: (value: string) => void;
    /** When the reader is done with the field: the calendar closed, the clear
     *  button pressed, or the time field left - after the new value has landed. */
    onBlur?: () => void;
    name?: string;
    id?: string;
    /** Same format as the value; days and times outside are not offered. */
    min?: string;
    max?: string;
    required?: boolean;
    disabled?: boolean;
    /** Offer a button that empties the field. Defaults to on unless required. */
    clearable?: boolean;
    placeholder?: string;
    className?: string;
    autoFocus?: boolean;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false";
    title?: string;
    step?: number | string;
}

const FIELD =
    "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-field px-2.5 text-left text-[0.8125rem] text-foreground transition-colors duration-fast hover:border-border-strong focus-visible:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger";

const TIME_FIELD =
    "h-8 min-w-0 rounded-md border border-border bg-field px-2.5 text-[0.8125rem] text-foreground [color-scheme:light] transition-colors duration-fast hover:border-border-strong focus:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 dark:[color-scheme:dark]";

/** A calendar day, without a time zone: what the value names, not an instant. */
interface Day {
    year: number;
    month: number;
    day: number;
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

export function formatDay({ year, month, day }: Day): string {
    return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function parseDay(value: string | undefined | null): Day | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
    if (!match) return null;
    const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const check = new Date(day.year, day.month - 1, day.day);
    return check.getMonth() === day.month - 1 && check.getDate() === day.day ? day : null;
}

function timeOf(value: string | undefined | null): string {
    return /T(\d{2}:\d{2}(?::\d{2})?)/.exec(value ?? "")?.[1] ?? "";
}

function shift(day: Day, days: number): Day {
    const next = new Date(day.year, day.month - 1, day.day + days);
    return { year: next.getFullYear(), month: next.getMonth() + 1, day: next.getDate() };
}

function shiftMonth(day: Day, months: number): Day {
    const first = new Date(day.year, day.month - 1 + months, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return { year: first.getFullYear(), month: first.getMonth() + 1, day: Math.min(day.day, last) };
}

function today(): Day {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** 0 for Sunday, 1 for Monday: the locale's first day of the week. */
export function weekStart(locale: string): number {
    try {
        const tag = new Intl.Locale(locale) as Intl.Locale & {
            getWeekInfo?: () => { firstDay: number };
            weekInfo?: { firstDay: number };
        };
        const info = tag.getWeekInfo?.() ?? tag.weekInfo;
        if (info) return info.firstDay % 7;
    } catch {
        // An engine without week data falls through to the region rule below.
    }
    return /-(US|CA|MX|BR|JP|IL|PH)/.test(locale) ? 0 : 1;
}

/** Whether a day can be picked within the bounds, compared on the day only. */
function within(day: Day, min?: string, max?: string): boolean {
    const text = formatDay(day);
    const low = parseDay(min);
    const high = parseDay(max);
    return (!low || text >= formatDay(low)) && (!high || text <= formatDay(high));
}

export function DateInput({
    mode = "date",
    value,
    defaultValue,
    onChange,
    onValueChange,
    name,
    id,
    min,
    max,
    required,
    disabled,
    clearable,
    placeholder,
    className,
    autoFocus,
    title,
    step,
    onBlur,
    ...aria
}: DateInputProps) {
    const t = useTranslations("components");
    const locale = useLocale();
    const [inner, setInner] = useState(defaultValue ?? "");
    const current = value ?? inner;
    const [open, setOpenState] = useState(false);
    // The latest handler, called a tick after the change so it reads the value
    // the parent has re-rendered with rather than the one it closed over.
    const blur = useRef(onBlur);
    blur.current = onBlur;
    const done = (): void => {
        setTimeout(() => blur.current?.(), 0);
    };
    function setOpen(next: boolean): void {
        setOpenState(next);
        if (!next && open) done();
    }
    const canClear = (clearable ?? !required) && current !== "" && !disabled;

    function commit(next: string): void {
        if (value === undefined) setInner(next);
        const target = { value: next, name: name ?? "" };
        onChange?.({ target, currentTarget: target });
        onValueChange?.(next);
    }

    if (mode === "time") {
        return (
            <input
                type="time"
                id={id}
                name={name}
                value={current}
                min={min}
                max={max}
                step={step}
                required={required}
                disabled={disabled}
                autoFocus={autoFocus}
                title={title}
                onChange={(event) => commit(event.target.value)}
                onBlur={done}
                className={cn(TIME_FIELD, "w-full", className)}
                {...aria}
            />
        );
    }

    const day = parseDay(current);
    const time = timeOf(current);
    const label = day
        ? new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              ...(mode === "datetime" && time ? { timeStyle: "short" } : {})
          }).format(
              new Date(
                  day.year,
                  day.month - 1,
                  day.day,
                  Number(time.slice(0, 2) || 0),
                  Number(time.slice(3, 5) || 0)
              )
          )
        : null;

    function pick(next: Day): void {
        if (mode === "datetime") {
            const minTime = min && formatDay(next) === min.slice(0, 10) ? timeOf(min) : "";
            commit(`${formatDay(next)}T${time || minTime || "09:00"}`);
            return;
        }
        commit(formatDay(next));
        setOpen(false);
    }

    return (
        <div className={cn("relative flex min-w-0 items-center", className)}>
            {/* What a form posts and checks: the same name and the same string the
                native field held, and the browser's "fill this in" on submit. */}
            {name || required ? (
                <input
                    tabIndex={-1}
                    aria-hidden="true"
                    name={name}
                    value={current}
                    required={required}
                    disabled={disabled}
                    onChange={() => undefined}
                    onFocus={() => setOpen(true)}
                    className="pointer-events-none absolute inset-0 size-full opacity-0"
                />
            ) : null}
            <Popover.Root open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
                <Popover.Trigger asChild>
                    <button
                        type="button"
                        id={id}
                        disabled={disabled}
                        autoFocus={autoFocus}
                        title={title}
                        aria-haspopup="dialog"
                        className={cn(FIELD, canClear && "pr-8")}
                        {...aria}
                    >
                        <CalendarDays
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate",
                                !label && "text-foreground-subtle"
                            )}
                        >
                            {label ??
                                placeholder ??
                                (mode === "datetime"
                                    ? t("dateInput.pickDateTime")
                                    : t("dateInput.pickDate"))}
                        </span>
                    </button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        align="start"
                        sideOffset={6}
                        collisionPadding={8}
                        className="z-50 max-h-[--radix-popover-content-available-height] w-[min(18rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-lg border border-border-strong bg-elevated p-3 text-foreground shadow-popover"
                        onOpenAutoFocus={(event) => event.preventDefault()}
                    >
                        <CalendarGrid
                            selected={day}
                            min={min}
                            max={max}
                            locale={locale}
                            onPick={pick}
                            labels={{
                                previous: t("dateInput.previousMonth"),
                                next: t("dateInput.nextMonth")
                            }}
                        />
                        {mode === "datetime" ? (
                            <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                                <label
                                    className="text-xs text-muted-foreground"
                                    htmlFor={`${id ?? name ?? "date"}-time`}
                                >
                                    {t("dateInput.time")}
                                </label>
                                <input
                                    id={`${id ?? name ?? "date"}-time`}
                                    type="time"
                                    value={time}
                                    step={step}
                                    disabled={!day}
                                    min={
                                        day && min && formatDay(day) === min.slice(0, 10)
                                            ? timeOf(min)
                                            : undefined
                                    }
                                    max={
                                        day && max && formatDay(day) === max.slice(0, 10)
                                            ? timeOf(max)
                                            : undefined
                                    }
                                    onChange={(event) =>
                                        day &&
                                        commit(`${formatDay(day)}T${event.target.value || "00:00"}`)
                                    }
                                    className={cn(TIME_FIELD, "flex-1")}
                                />
                            </div>
                        ) : null}
                        <div className="mt-3 flex items-center justify-between gap-2">
                            <button
                                type="button"
                                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                                disabled={!within(today(), min, max)}
                                onClick={() => pick(today())}
                            >
                                {t("dateInput.today")}
                            </button>
                            {canClear ? (
                                <button
                                    type="button"
                                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                    onClick={() => {
                                        commit("");
                                        setOpen(false);
                                    }}
                                >
                                    {t("dateInput.clear")}
                                </button>
                            ) : null}
                        </div>
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
            {canClear ? (
                <button
                    type="button"
                    onClick={() => {
                        commit("");
                        done();
                    }}
                    aria-label={t("dateInput.clear")}
                    title={t("dateInput.clear")}
                    className="absolute right-1 grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    <X className="size-3.5" aria-hidden="true" />
                </button>
            ) : null}
        </div>
    );
}

/** One month as a keyboard grid; the focused day moves with the arrows. */
export function CalendarGrid({
    selected,
    min,
    max,
    locale,
    onPick,
    labels
}: {
    selected: Day | null;
    min?: string;
    max?: string;
    locale: string;
    onPick: (day: Day) => void;
    labels: { previous: string; next: string };
}) {
    const [focus, setFocus] = useState<Day>(() => selected ?? clampDay(today(), min, max));
    const grid = useRef<HTMLDivElement>(null);
    const headingId = useId();
    const first = weekStart(locale);

    useEffect(() => {
        // The focused day takes the focus, so the arrows work as soon as it opens.
        grid.current
            ?.querySelector<HTMLButtonElement>(`[data-day="${formatDay(focus)}"]`)
            ?.focus({ preventScroll: true });
    }, [focus]);

    const weekdays = useMemo(() => {
        const format = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
        const long = new Intl.DateTimeFormat(locale, { weekday: "long" });
        // 2023-01-01 was a Sunday.
        return Array.from({ length: 7 }, (_, index) => {
            const date = new Date(2023, 0, 1 + ((first + index) % 7));
            return { short: format.format(date), long: long.format(date) };
        });
    }, [locale, first]);

    const cells = useMemo(() => {
        const start = new Date(focus.year, focus.month - 1, 1);
        const offset = (start.getDay() - first + 7) % 7;
        const length = new Date(focus.year, focus.month, 0).getDate();
        const rows: (Day | null)[] = Array.from({ length: offset }, () => null);
        for (let day = 1; day <= length; day++)
            rows.push({ year: focus.year, month: focus.month, day });
        while (rows.length % 7 !== 0) rows.push(null);
        return rows;
    }, [focus.year, focus.month, first]);

    const todayText = formatDay(today());
    const selectedText = selected ? formatDay(selected) : null;
    const dayLabel = new Intl.DateTimeFormat(locale, { dateStyle: "full" });

    function onKey(event: KeyboardEvent<HTMLDivElement>): void {
        const moves: Record<string, () => Day> = {
            ArrowLeft: () => shift(focus, -1),
            ArrowRight: () => shift(focus, 1),
            ArrowUp: () => shift(focus, -7),
            ArrowDown: () => shift(focus, 7),
            PageUp: () => shiftMonth(focus, event.shiftKey ? -12 : -1),
            PageDown: () => shiftMonth(focus, event.shiftKey ? 12 : 1),
            Home: () =>
                shift(
                    focus,
                    -((new Date(focus.year, focus.month - 1, focus.day).getDay() - first + 7) % 7)
                ),
            End: () =>
                shift(
                    focus,
                    6 -
                        ((new Date(focus.year, focus.month - 1, focus.day).getDay() - first + 7) %
                            7)
                )
        };
        const next = moves[event.key];
        if (next) {
            event.preventDefault();
            setFocus(next());
            return;
        }
        if ((event.key === "Enter" || event.key === " ") && within(focus, min, max)) {
            event.preventDefault();
            onPick(focus);
        }
    }

    const heading = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
        new Date(focus.year, focus.month - 1, 1)
    );

    return (
        <div>
            <div className="mb-2 flex items-center justify-between gap-2">
                <button
                    type="button"
                    aria-label={labels.previous}
                    title={labels.previous}
                    onClick={() => setFocus(shiftMonth(focus, -1))}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <p
                    id={headingId}
                    aria-live="polite"
                    className="min-w-0 truncate text-sm font-medium capitalize"
                >
                    {heading}
                </p>
                <button
                    type="button"
                    aria-label={labels.next}
                    title={labels.next}
                    onClick={() => setFocus(shiftMonth(focus, 1))}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    <ChevronRight className="size-4" aria-hidden="true" />
                </button>
            </div>
            <div ref={grid} role="grid" aria-labelledby={headingId} onKeyDown={onKey}>
                <div role="row" className="grid grid-cols-7">
                    {weekdays.map((weekday) => (
                        <span
                            key={weekday.long}
                            role="columnheader"
                            aria-label={weekday.long}
                            className="py-1 text-center text-[0.6875rem] font-medium text-muted-foreground"
                        >
                            {weekday.short}
                        </span>
                    ))}
                </div>
                {Array.from({ length: cells.length / 7 }, (_, row) => (
                    <div key={row} role="row" className="grid grid-cols-7">
                        {cells.slice(row * 7, row * 7 + 7).map((cell, index) => {
                            if (!cell) return <span key={`blank-${index}`} role="gridcell" />;
                            const text = formatDay(cell);
                            const allowed = within(cell, min, max);
                            const chosen = text === selectedText;
                            return (
                                <span key={text} role="gridcell" aria-selected={chosen}>
                                    <button
                                        type="button"
                                        data-day={text}
                                        tabIndex={text === formatDay(focus) ? 0 : -1}
                                        disabled={!allowed}
                                        aria-label={dayLabel.format(
                                            new Date(cell.year, cell.month - 1, cell.day)
                                        )}
                                        aria-current={text === todayText ? "date" : undefined}
                                        onClick={() => onPick(cell)}
                                        onFocus={() => text !== formatDay(focus) && setFocus(cell)}
                                        className={cn(
                                            "mx-auto grid size-8 place-items-center rounded-md text-[0.8125rem] tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-35",
                                            chosen
                                                ? "bg-primary text-primary-foreground"
                                                : "hover:bg-muted",
                                            !chosen &&
                                                text === todayText &&
                                                "font-semibold text-primary"
                                        )}
                                    >
                                        {cell.day}
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

function clampDay(day: Day, min?: string, max?: string): Day {
    const low = parseDay(min);
    const high = parseDay(max);
    if (low && formatDay(day) < formatDay(low)) return low;
    if (high && formatDay(day) > formatDay(high)) return high;
    return day;
}
