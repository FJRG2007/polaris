"use client";

/**
 * A card an installed app put on the Overview, drawn by the dashboard.
 *
 * The app says what to show - a row per thing it watches, a few readings, the
 * switches and settings that can be changed from here - and this draws it in
 * the Overview's own frame, so a card from Places looks like a card from
 * Polaris. A change is shown at once and taken back, with the app's reason, if
 * the app refuses it.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, ChevronDown, Minus, Plus } from "lucide-react";
import {
    Badge,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Switch,
    cn
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AppWidgetReadout } from "@/lib/overview/app-widgets";
import { WidgetEmpty, WidgetRowsSkeleton, WidgetUnavailable } from "./widget-card";
import type { AppWidgetControl, AppWidgetInput, AppWidgetItem } from "@/lib/app-extensions/types";

const TONE: Record<
    NonNullable<AppWidgetItem["tone"]>,
    "success" | "warning" | "danger" | "neutral"
> = {
    ok: "success",
    warn: "warning",
    bad: "danger",
    off: "neutral"
};

const READING_TONE = { ok: "text-success", warn: "text-warning", bad: "text-danger" } as const;

/** What the card body draws, from what its app answered. Undefined is still on
 *  its way. */
export function AppWidgetBody({
    readout,
    busy,
    onAct,
    onConfigure
}: {
    readout: AppWidgetReadout | undefined;
    /** The controls a press is still out for, by `item:control`. */
    busy: ReadonlySet<string>;
    onAct: (input: AppWidgetInput) => void;
    onConfigure: () => void;
}) {
    const t = useTranslations("home");
    if (readout === undefined) return <WidgetRowsSkeleton rows={2} />;
    if (!readout.ok) {
        return (
            <WidgetUnavailable>
                {readout.reason === "gone" ? t("appCards.gone") : t("appCards.readFailed")}
            </WidgetUnavailable>
        );
    }
    if (readout.view.items.length === 0) {
        return (
            <WidgetEmpty
                action={
                    <button
                        type="button"
                        onClick={onConfigure}
                        className="text-xs font-medium text-primary hover:underline"
                    >
                        {t("appCards.pick")}
                    </button>
                }
            >
                {t("appCards.empty")}
            </WidgetEmpty>
        );
    }
    return (
        <ul className="-mx-1 flex flex-col divide-y divide-border">
            {readout.view.items.map((item) => (
                <li key={item.id} className="flex flex-col gap-2 px-1 py-2 first:pt-0 last:pb-0">
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1">
                            {item.href ? (
                                <Link
                                    href={item.href}
                                    className="block truncate text-sm font-medium hover:underline"
                                    title={item.title}
                                >
                                    {item.title}
                                </Link>
                            ) : (
                                <p className="truncate text-sm font-medium" title={item.title}>
                                    {item.title}
                                </p>
                            )}
                            {item.subtitle ? (
                                <p
                                    className="truncate text-xs text-muted-foreground"
                                    title={item.subtitle}
                                >
                                    {item.subtitle}
                                </p>
                            ) : null}
                        </div>
                        {item.state ? (
                            <Badge variant={item.tone ? TONE[item.tone] : "neutral"}>
                                {item.state}
                            </Badge>
                        ) : null}
                    </div>
                    {item.readings.length > 0 ? (
                        <dl className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-3 gap-y-1">
                            {item.readings.map((reading) => (
                                <div key={reading.label} className="min-w-0">
                                    <dt className="truncate text-[11px] text-muted-foreground">
                                        {reading.label}
                                    </dt>
                                    <dd
                                        className={cn(
                                            "truncate text-sm font-medium tabular-nums",
                                            reading.tone && READING_TONE[reading.tone]
                                        )}
                                        title={reading.value}
                                    >
                                        {reading.value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    ) : null}
                    {item.controls.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            {item.controls.map((control) => (
                                <Control
                                    key={control.id}
                                    item={item}
                                    control={control}
                                    busy={busy.has(`${item.id}:${control.id}`)}
                                    onAct={onAct}
                                />
                            ))}
                        </div>
                    ) : null}
                </li>
            ))}
        </ul>
    );
}

function Control({
    item,
    control,
    busy,
    onAct
}: {
    item: AppWidgetItem;
    control: AppWidgetControl;
    busy: boolean;
    onAct: (input: AppWidgetInput) => void;
}) {
    const t = useTranslations("home");
    const blocked = Boolean(control.disabled) || busy;
    const why = control.disabled ?? undefined;
    if (control.kind === "toggle") {
        return (
            <label className="flex items-center gap-2 text-xs" title={why}>
                <Switch
                    checked={control.on}
                    disabled={blocked}
                    aria-label={`${control.label} - ${item.title}`}
                    aria-describedby={why ? `${item.id}-${control.id}-why` : undefined}
                    onChange={(on) => onAct({ item: item.id, control: control.id, value: on })}
                />
                {control.label}
                {why ? (
                    <span id={`${item.id}-${control.id}-why`} className="sr-only">
                        {why}
                    </span>
                ) : null}
            </label>
        );
    }
    if (control.kind === "choice") {
        return <ChoiceControl item={item} control={control} blocked={blocked} onAct={onAct} />;
    }
    if (control.kind === "action") {
        return <ActionControl item={item} control={control} blocked={blocked} onAct={onAct} />;
    }
    const value = control.value;
    const step = (direction: 1 | -1) => {
        const from = value ?? (direction > 0 ? control.min : control.max);
        const next = Math.min(control.max, Math.max(control.min, from + direction * control.step));
        // Rounded to the step's own places, so 21.5 + 0.5 is 22 and not 21.999.
        const places = String(control.step).split(".")[1]?.length ?? 0;
        onAct({ item: item.id, control: control.id, value: Number(next.toFixed(places)) });
    };
    return (
        <div className="flex items-center gap-1.5 text-xs" title={why}>
            <span className="text-muted-foreground">{control.label}</span>
            <button
                type="button"
                disabled={blocked || (value !== null && value <= control.min)}
                onClick={() => step(-1)}
                aria-label={t("appCards.decrease", { label: control.label, name: item.title })}
                className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
                <Minus className="size-3.5" aria-hidden="true" />
            </button>
            <span
                className="min-w-12 text-center text-sm font-medium tabular-nums"
                aria-live="polite"
            >
                {value === null ? "-" : `${value}${control.unit}`}
            </span>
            <button
                type="button"
                disabled={blocked || (value !== null && value >= control.max)}
                onClick={() => step(1)}
                aria-label={t("appCards.increase", { label: control.label, name: item.title })}
                className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
                <Plus className="size-3.5" aria-hidden="true" />
            </button>
        </div>
    );
}

/** How long a button that asks for a second press waits for it. */
const CONFIRM_MS = 4_000;

/** One of a few named settings, picked from a menu - never a native select,
 *  which cannot be styled to the page and closes on its own in some browsers. */
function ChoiceControl({
    item,
    control,
    blocked,
    onAct
}: {
    item: AppWidgetItem;
    control: Extract<AppWidgetControl, { kind: "choice" }>;
    blocked: boolean;
    onAct: (input: AppWidgetInput) => void;
}) {
    const current = control.options.find((option) => option.value === control.value);
    const why = control.disabled ?? undefined;
    return (
        <div className="flex min-w-0 items-center gap-1.5 text-xs" title={why}>
            <span className="shrink-0 text-muted-foreground">{control.label}</span>
            <DropdownMenu>
                <DropdownMenuTrigger asChild disabled={blocked}>
                    <button
                        type="button"
                        aria-label={`${control.label} - ${item.title}`}
                        className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-border px-2 text-sm font-medium transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                    >
                        <span className="truncate" title={current?.label}>
                            {current?.label ?? "-"}
                        </span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-36">
                    {control.options.map((option) => (
                        <DropdownMenuItem
                            key={option.value}
                            onSelect={() => {
                                if (option.value === control.value) return;
                                onAct({ item: item.id, control: control.id, value: option.value });
                            }}
                            className={cn(option.value === control.value && "text-primary")}
                        >
                            <Check
                                className={cn(
                                    "size-4 shrink-0",
                                    option.value !== control.value && "invisible"
                                )}
                                aria-hidden="true"
                            />
                            {option.label}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

/** A button that does one thing. One that asks for a second press says so on
 *  itself, and goes back to its own word if the second press does not come. */
function ActionControl({
    item,
    control,
    blocked,
    onAct
}: {
    item: AppWidgetItem;
    control: Extract<AppWidgetControl, { kind: "action" }>;
    blocked: boolean;
    onAct: (input: AppWidgetInput) => void;
}) {
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) return;
        const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS);
        return () => window.clearTimeout(timer);
    }, [armed]);
    const why = control.disabled ?? undefined;
    const label = armed && control.confirm ? control.confirm : control.label;
    return (
        <button
            type="button"
            disabled={blocked}
            title={why}
            aria-label={`${label} - ${item.title}`}
            onClick={() => {
                if (control.confirm && !armed) {
                    setArmed(true);
                    return;
                }
                setArmed(false);
                onAct({ item: item.id, control: control.id, value: true });
            }}
            className={cn(
                "h-7 max-w-full truncate rounded-md border px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
                armed
                    ? "border-warning bg-warning/10 text-warning"
                    : "border-border hover:bg-muted"
            )}
        >
            {label}
        </button>
    );
}

/** The view with one control already set to what was pressed - drawn while
 *  the app is asked, and replaced by its answer. */
export function withPressed(readout: AppWidgetReadout, input: AppWidgetInput): AppWidgetReadout {
    if (!readout.ok) return readout;
    return {
        ok: true,
        view: {
            items: readout.view.items.map((item) =>
                item.id !== input.item
                    ? item
                    : {
                          ...item,
                          controls: item.controls.map((control) =>
                              control.id !== input.control
                                  ? control
                                  : control.kind === "toggle"
                                    ? { ...control, on: Boolean(input.value) }
                                    : control.kind === "number"
                                      ? { ...control, value: Number(input.value) }
                                      : control.kind === "choice"
                                        ? { ...control, value: String(input.value) }
                                        : control
                          )
                      }
            )
        }
    };
}
