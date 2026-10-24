"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import { ColorWheel } from "./color-wheel";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

/** How long a slider is left still before what it says is sent: a drag is one
 *  setting, not forty. */
const SETTLE_MS = 400;

const WARMTH_TRACK = "linear-gradient(to right, #ffb46b, #fff1e0, #dbe8ff)";

/** A slider that shows where it is dragged at once and sends only once it is
 *  let go of for a moment. The row's own optimistic update and rollback are
 *  `useDeviceAct`'s, which is what `onCommit` reaches. */
function SettlingSlider({
    label,
    value,
    min,
    max,
    step,
    unit,
    disabled,
    track,
    onCommit
}: {
    label: string;
    value: number | null;
    min: number;
    max: number;
    step: number;
    unit: string;
    disabled: boolean;
    track?: string;
    onCommit: (value: number) => void;
}) {
    const [shown, setShown] = useState<number | null>(value);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pending = useRef<number | null>(null);
    const commit = useRef(onCommit);
    commit.current = onCommit;
    // A later sync wins over a drag that has already been sent.
    useEffect(() => {
        if (!timer.current) setShown(value);
    }, [value]);
    const flush = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        if (next !== null) commit.current(next);
    };
    // Leaving with a drag gathered sends it rather than dropping it.
    useEffect(() => () => flush(), []);
    const change = (next: number) => {
        setShown(next);
        pending.current = next;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, SETTLE_MS);
    };
    return (
        <label className="flex min-w-0 flex-col gap-1">
            <span className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{label}</span>
                <span className="shrink-0 tabular-nums">
                    {shown === null ? "-" : `${shown}${unit}`}
                </span>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={shown ?? min}
                disabled={disabled}
                aria-label={label}
                onChange={(event) => change(Number(event.target.value))}
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                style={track ? { background: track } : undefined}
            />
        </label>
    );
}

/** Brightness, colour temperature and a colour wheel, each drawn only when the light has it. */
export function LightControls({
    device,
    canControl,
    onAct,
    className
}: {
    device: DeviceView;
    canControl: boolean;
    onAct: (action: DeviceAction, command?: DeviceCommand) => void;
    className?: string;
}) {
    const t = usePlacesT();
    const light = device.light ?? null;
    if (!light) return null;
    const disabled = !canControl || !device.online;
    return (
        <div className={cn("flex flex-col gap-3", className)}>
            {light.brightness ? (
                <SettlingSlider
                    label={t("devices.actions.set-brightness")}
                    value={light.brightness.level}
                    min={1}
                    max={100}
                    step={1}
                    unit="%"
                    disabled={disabled}
                    onCommit={(level) =>
                        onAct("set-brightness", { action: "set-brightness", level })
                    }
                />
            ) : null}
            {light.temperature ? (
                <SettlingSlider
                    label={t("devices.actions.set-color-temp")}
                    value={light.temperature.kelvin}
                    min={light.temperature.min}
                    max={light.temperature.max}
                    step={50}
                    unit=" K"
                    disabled={disabled}
                    track={WARMTH_TRACK}
                    onCommit={(kelvin) =>
                        onAct("set-color-temp", { action: "set-color-temp", kelvin })
                    }
                />
            ) : null}
            {light.color ? (
                <ColorWheel
                    label={t("devices.actions.set-color")}
                    valueText={({ hue, saturation }) =>
                        t("devices.colorValue", { hue, saturation })
                    }
                    value={
                        light.color.hue === null
                            ? null
                            : { hue: light.color.hue, saturation: light.color.saturation ?? 100 }
                    }
                    disabled={disabled}
                    onCommit={({ hue, saturation }) =>
                        onAct("set-color", { action: "set-color", hue, saturation })
                    }
                />
            ) : null}
        </div>
    );
}
