"use client";

/**
 * An air purifier's or humidifier's controls: its power, the preset or fan speed
 * it runs, the humidity it aims for, its switches - and, in the panel, what it
 * measures and how worn its filters are.
 *
 * Built like the air conditioner's (`climate-controls.tsx`): every control moves
 * the moment it is used, the screen above puts it back if the unit refuses, and
 * the humidity stepper gathers presses into one change. What a unit cannot do is
 * never offered; when it cannot be operated at all the controls stay, showing
 * its settings, and say why.
 *
 * A preset and a fan speed are one choice on the unit - picking a speed leaves
 * the preset - so both pickers are drawn and whichever is not running shows its
 * placeholder rather than a value that is no longer true.
 */

import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { useEffect, useId, useRef, useState } from "react";
import { Droplets, Minus, Plus, Wind } from "lucide-react";
import { DeviceSwitch, controlReason } from "./device-switch";
import { Badge, Button, Select, Switch, cn } from "@polaris/ui";
import type { AirSettings, DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

/** How long the stepper waits for another press before it sends the total. */
const STEP_SETTLE_MS = 700;

const FILTER_TONES: Readonly<Record<kinds.FilterState, string>> = {
    ok: "border-border bg-muted text-muted-foreground",
    soon: "border-warning-edge bg-warning-soft text-warning-ink",
    now: "border-danger-edge bg-danger-soft text-danger-ink"
};

/** Each air-quality level's colours. The level's name is always written in the
 *  chip, so the colour only repeats what the words already say. */
const QUALITY_TONES: Readonly<Record<kinds.AirQualityLevel, string>> = {
    good: "border-success-edge bg-success-soft text-success-ink",
    fair: "border-border bg-muted text-muted-foreground",
    moderate: "border-warning-edge bg-warning-soft text-warning-ink",
    poor: "border-warning-edge bg-warning-soft text-warning-ink",
    veryPoor: "border-danger-edge bg-danger-soft text-danger-ink",
    extremelyPoor: "border-danger-edge bg-danger-soft text-danger-ink"
};

/** How good the air is, as a word next to the figure it was judged from, with
 *  what to do about it on hover - or, in the panel, written underneath. */
export function AirQualityChip({
    air,
    detailed = false,
    className
}: {
    air: AirSettings | null | undefined;
    detailed?: boolean;
    className?: string;
}) {
    const t = usePlacesT();
    const quality = kinds.airQuality(air);
    if (!quality) return null;
    const level = kinds.airQualityText(quality.level, t);
    const hint = kinds.airQualityHint(quality.level, t);
    const chip = (
        <Badge
            className={cn("shrink-0", QUALITY_TONES[quality.level], !detailed && className)}
            title={detailed ? undefined : hint}
        >
            <span className="sr-only">{t("devicePanel.air.quality")}: </span>
            {level}
        </Badge>
    );
    if (!detailed) return chip;
    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            <span className="text-xs text-muted-foreground">{t("devicePanel.air.quality")}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {chip}
                <span className="text-xs text-muted-foreground">{hint}</span>
            </span>
        </div>
    );
}

/** The chip a worn filter gets, on the row and in the panel. Nothing while every
 *  filter is fine: a row of "OK" chips would be noise. */
export function FilterChip({
    air,
    className
}: {
    air: AirSettings | null | undefined;
    className?: string;
}) {
    const t = usePlacesT();
    const worn = kinds.wornFilter(air);
    if (!worn || worn.state === "ok") return null;
    return (
        <Badge
            className={cn("shrink-0", FILTER_TONES[worn.state], className)}
            title={kinds.airFilterText(worn.kind, t)}
        >
            {t(worn.state === "now" ? "devicesView.filterNow" : "devicesView.filterSoon")}
        </Badge>
    );
}

export function AirControls({
    device,
    canControl,
    busy,
    onAct,
    detailed = false,
    className
}: {
    device: DeviceView;
    canControl: boolean;
    busy: DeviceAction | null;
    onAct: (action: DeviceAction, command?: DeviceCommand) => void;
    /** The panel's version: labelled, with the switches, readings and filters. */
    detailed?: boolean;
    className?: string;
}) {
    const t = usePlacesT();
    const reasonId = useId();
    const air = device.air ?? null;
    const reason = controlReason(device, canControl, t);
    const locked = reason !== "";

    // The humidity target as the stepper shows it while presses are gathered;
    // null whenever nothing is waiting, so the unit's own value is shown.
    const [draft, setDraft] = useState<number | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pending = useRef<number | null>(null);
    const send = useRef(onAct);
    send.current = onAct;

    const flush = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        const target = pending.current;
        pending.current = null;
        setDraft(null);
        if (target !== null) send.current("set-humidity", { action: "set-humidity", target });
    };

    // Leaving with a change gathered sends it rather than dropping it.
    useEffect(() => () => flush(), []);

    // Pressed back to where the unit already is: nothing to send.
    const settledTarget = air?.humidity?.target ?? null;
    useEffect(() => {
        if (draft !== null && draft === settledTarget && pending.current === settledTarget) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            pending.current = null;
            setDraft(null);
        }
    }, [draft, settledTarget]);

    const switchControl = (
        <DeviceSwitch
            device={device}
            canControl={canControl}
            busy={busy !== null}
            onAct={(action) => onAct(action)}
            className={detailed ? "h-8" : undefined}
        />
    );

    if (!air) {
        return (
            <div className={cn("flex flex-wrap items-center gap-2", className)}>
                {switchControl}
                {detailed && (
                    <p className="text-xs text-muted-foreground">{t("devicePanel.air.unknown")}</p>
                )}
            </div>
        );
    }

    const disabled = locked || busy !== null;
    const describedBy = locked ? reasonId : undefined;
    const label = (text: string) =>
        detailed ? <span className="text-xs text-muted-foreground">{text}</span> : null;

    const headline = kinds.airHeadline(air);
    const reading = headline && (
        <span
            className="inline-flex shrink-0 items-center gap-1 text-sm tabular-nums text-muted-foreground"
            title={kinds.airMeasureText(headline.measure, t)}
        >
            {headline.measure === "humidity" ? (
                <Droplets className="size-4 shrink-0" aria-hidden="true" />
            ) : (
                <Wind className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="sr-only">{kinds.airMeasureText(headline.measure, t)}</span>
            {kinds.measureLine(headline.measure, Number(headline.value))}
        </span>
    );

    const mode = air.modes.length > 0 && (
        <label className="flex min-w-0 flex-col gap-1" title={reason || undefined}>
            {label(t("devicePanel.air.mode"))}
            <Select
                value={air.mode ?? ""}
                placeholder={t("devicePanel.air.noMode")}
                disabled={disabled}
                aria-label={t("devicePanel.air.modeName", { name: device.name })}
                className="w-36"
                options={air.modes.map((value) => ({ value, label: kinds.airModeText(value, t) }))}
                onValueChange={(value) => {
                    const next = kinds.AIR_MODES.find((entry) => entry === value);
                    if (next && next !== air.mode)
                        onAct("set-mode", { action: "set-mode", mode: next });
                }}
            />
        </label>
    );

    const speed = air.speeds.length > 0 && (
        <label className="flex min-w-0 flex-col gap-1" title={reason || undefined}>
            {label(t("devicePanel.air.speed"))}
            <Select
                value={air.speed ?? ""}
                placeholder={t("devicePanel.air.noSpeed")}
                disabled={disabled}
                aria-label={t("devicePanel.air.speedName", { name: device.name })}
                className="w-32"
                options={air.speeds.map((value) => ({
                    value,
                    label: kinds.airSpeedText(value, t)
                }))}
                onValueChange={(value) => {
                    const next = kinds.AIR_SPEEDS.find((entry) => entry === value);
                    if (next && next !== air.speed)
                        onAct("set-fan", { action: "set-fan", speed: next });
                }}
            />
        </label>
    );

    const range = air.humidity;
    const shown = draft ?? range?.target ?? null;
    const nudge = (direction: 1 | -1) => {
        if (!range) return;
        const from = pending.current ?? range.target ?? range.min;
        const next =
            Math.round(
                Math.min(range.max, Math.max(range.min, from + direction * range.step)) * 100
            ) / 100;
        if (next === (pending.current ?? range.target)) return;
        pending.current = next;
        setDraft(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, STEP_SETTLE_MS);
    };

    const humidity = range && (
        <div className="flex flex-col gap-1" title={reason || undefined}>
            {label(t("devicePanel.air.target"))}
            <div
                role="group"
                aria-label={t("devicePanel.air.targetName", { name: device.name })}
                aria-describedby={describedBy}
                className="inline-flex h-8 items-center rounded-md border border-border"
            >
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-full rounded-r-none px-2"
                    aria-label={t("devicePanel.air.lower", { name: device.name })}
                    title={t("devicePanel.air.lower", { name: device.name })}
                    disabled={disabled || (shown !== null && shown <= range.min)}
                    onClick={() => nudge(-1)}
                >
                    <Minus className="size-4" aria-hidden="true" />
                </Button>
                <output
                    aria-live="polite"
                    className="min-w-[3.5rem] px-1 text-center text-sm font-medium tabular-nums"
                >
                    {shown === null ? "-" : `${shown}%`}
                </output>
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-full rounded-l-none px-2"
                    aria-label={t("devicePanel.air.raise", { name: device.name })}
                    title={t("devicePanel.air.raise", { name: device.name })}
                    disabled={disabled || (shown !== null && shown >= range.max)}
                    onClick={() => nudge(1)}
                >
                    <Plus className="size-4" aria-hidden="true" />
                </Button>
            </div>
        </div>
    );

    const switches = kinds.AIR_OPTIONS.filter((option) => air.options[option] !== undefined);
    const measures = kinds.AIR_MEASURES.filter((measure) => air.readings[measure] !== undefined);

    return (
        <div className={cn("flex flex-col gap-3", className)}>
            <div
                className={cn(
                    "flex flex-wrap gap-x-3 gap-y-2",
                    detailed ? "items-end" : "items-center"
                )}
            >
                {switchControl}
                {reading}
                {!detailed && <AirQualityChip air={air} />}
                {mode}
                {speed}
                {detailed && humidity}
                {locked && (
                    <span id={reasonId} className="sr-only">
                        {reason}
                    </span>
                )}
            </div>
            {detailed && <AirQualityChip air={air} detailed />}
            {detailed && switches.length > 0 && (
                <fieldset className="flex flex-col gap-2" aria-describedby={describedBy}>
                    <legend className="mb-1 text-xs text-muted-foreground">
                        {t("devicePanel.air.switches")}
                    </legend>
                    <div className="flex flex-wrap gap-x-5 gap-y-2" title={reason || undefined}>
                        {switches.map((option) => (
                            <label key={option} className="inline-flex items-center gap-2 text-sm">
                                <Switch
                                    checked={air.options[option] === true}
                                    disabled={disabled}
                                    aria-label={t("devicePanel.air.optionName", {
                                        option: kinds.airOptionText(option, t),
                                        name: device.name
                                    })}
                                    onChange={(on) =>
                                        onAct("set-option", { action: "set-option", option, on })
                                    }
                                />
                                {kinds.airOptionText(option, t)}
                            </label>
                        ))}
                    </div>
                </fieldset>
            )}
            {detailed && measures.length > 0 && (
                <section className="flex flex-col gap-2">
                    <h3 className="text-xs text-muted-foreground">
                        {t("devicePanel.air.readings")}
                    </h3>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                        {measures.map((measure) => (
                            <div key={measure} className="flex min-w-0 flex-col">
                                <dt
                                    className="truncate text-xs text-foreground-subtle"
                                    title={kinds.airMeasureText(measure, t)}
                                >
                                    {kinds.airMeasureText(measure, t)}
                                </dt>
                                <dd className="text-sm font-medium tabular-nums">
                                    {kinds.measureLine(measure, air.readings[measure] ?? 0)}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>
            )}
            {detailed && air.filters.length > 0 && (
                <section className="flex flex-col gap-2">
                    <h3 className="text-xs text-muted-foreground">
                        {t("devicePanel.air.filters")}
                    </h3>
                    <ul className="flex flex-col gap-1.5">
                        {air.filters.map((filter, index) => (
                            <li
                                key={`${filter.kind}-${index}`}
                                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
                            >
                                <span
                                    className="min-w-0 flex-1 truncate text-sm"
                                    title={kinds.airFilterText(filter.kind, t)}
                                >
                                    {kinds.airFilterText(filter.kind, t)}
                                </span>
                                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                                    {filter.percent !== null
                                        ? t("devicePanel.air.lifePercent", {
                                              percent: Math.round(filter.percent)
                                          })
                                        : filter.hours !== null
                                          ? t("devicePanel.air.lifeHours", {
                                                hours: Math.round(filter.hours)
                                            })
                                          : ""}
                                </span>
                                <Badge className={cn("shrink-0", FILTER_TONES[filter.state])}>
                                    {kinds.filterStateText(filter.state, t)}
                                </Badge>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}
