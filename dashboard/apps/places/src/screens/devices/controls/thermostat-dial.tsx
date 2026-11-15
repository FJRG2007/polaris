"use client";

/**
 * The thermostat dial: drag the handle round the arc to set the temperature,
 * with the target and the room's temperature large in the middle. Modelled on
 * Home Assistant's `ha-state-control-climate-temperature` and
 * `ha-control-circular-slider` (Apache-2.0, adapted rather than copied) and the
 * Nest / Google Home thermostat: the arc is coloured by what the unit is doing -
 * warm for heating, cool for cooling - and a unit that keeps a range shows two
 * handles, the low end and the high.
 *
 * Only a press on the ring drags, so the number in the middle stays a button of
 * its own (the caller's `children`). Every handle is a keyboard slider; values
 * shown while dragging are on the unit's step and only the one let go on is
 * sent (`useReleasedValue`).
 */

import { cn, keyedValue, useReleasedValue, type ValueRange } from "@polaris/ui";
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
    DIAL_START,
    DIAL_SWEEP,
    angleFromValue,
    arcPath,
    dialValueFromPoint,
    moveSetpoint,
    nearerSetpoint,
    pointAt,
    type DualSetpoint
} from "./dial-math";

/** What the unit is doing, which colours the arc. */
export type DialTone = "heat" | "cool" | "auto" | "dry" | "idle";

/** The arc's colour for each tone. Cooling has no status token of its own, so it
 *  is the blue every thermostat uses for it; the rest are the theme's. */
const TONE_COLORS: Readonly<Record<DialTone, string>> = {
    heat: "hsl(var(--warning))",
    cool: "hsl(205 88% 55%)",
    auto: "hsl(var(--success))",
    dry: "hsl(46 92% 50%)",
    idle: "hsl(var(--muted-foreground))"
};

const SIZE = 320;
const CENTER = SIZE / 2;
const RADIUS = 136;
const STROKE = 28;

type Points = readonly number[];

export interface ThermostatDialProps {
    range: ValueRange;
    /** The single target, when the unit keeps one. */
    value?: number | null;
    /** Both ends, when the unit keeps a range instead: drawn as two handles. */
    setpoints?: DualSetpoint | null;
    tone?: DialTone;
    /** The room's temperature, marked on the arc. */
    current?: number | null;
    /** The accessible name of the single handle. */
    label: string;
    lowLabel?: string;
    highLabel?: string;
    valueText: (value: number) => string;
    disabled?: boolean;
    describedBy?: string;
    onCommit?: (value: number) => void;
    onCommitRange?: (setpoints: DualSetpoint) => void;
    /** The single target being shown while one is held, or null once it is the unit's again. */
    onLive?: (value: number | null) => void;
    settleMs?: number;
    /** The middle of the dial: the big number. */
    children?: ReactNode;
    className?: string;
}

export function ThermostatDial({
    range,
    value = null,
    setpoints = null,
    tone = "idle",
    current = null,
    label,
    lowLabel,
    highLabel,
    valueText,
    disabled = false,
    describedBy,
    onCommit,
    onCommitRange,
    onLive,
    settleMs,
    children,
    className
}: ThermostatDialProps) {
    const dual = setpoints !== null;
    const device: Points = dual ? [setpoints.low, setpoints.high] : value === null ? [] : [value];
    const held = useReleasedValue<Points>(
        device,
        (next) => {
            if (dual && next.length === 2) onCommitRange?.({ low: next[0]!, high: next[1]! });
            else if (!dual && next.length === 1) onCommit?.(next[0]!);
        },
        {
            settleMs,
            onLive: dual || !onLive ? undefined : (shown) => onLive(shown?.[0] ?? null)
        }
    );
    const shown = held.shown;
    const active = useRef(0);
    const [focused, setFocused] = useState<number | null>(null);
    const color = TONE_COLORS[tone];

    const moved = (points: Points, index: number, to: number): Points => {
        if (!dual) return [to];
        const pair = { low: points[0]!, high: points[1]! };
        const next = moveSetpoint(pair, index === 0 ? "low" : "high", to, range);
        return [next.low, next.high];
    };

    const offsets = (event: ReactPointerEvent<SVGSVGElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        const scale = box.width > 0 ? SIZE / box.width : 1;
        return {
            dx: (event.clientX - (box.left + box.width / 2)) * scale,
            dy: (event.clientY - (box.top + box.height / 2)) * scale
        };
    };

    const start = (event: ReactPointerEvent<SVGSVGElement>) => {
        if (disabled || event.button > 0 || shown.length === 0) return;
        const { dx, dy } = offsets(event);
        const distance = Math.hypot(dx, dy);
        // The ring only: the middle is the number's own button.
        if (distance < RADIUS - STROKE * 1.25 || distance > CENTER) return;
        const to = dialValueFromPoint(dx, dy, range);
        active.current = dual
            ? nearerSetpoint({ low: shown[0]!, high: shown[1]! }, to) === "low"
                ? 0
                : 1
            : 0;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        held.drag(moved(shown, active.current, to));
    };

    const drag = (event: ReactPointerEvent<SVGSVGElement>) => {
        if (disabled || !held.holding()) return;
        const { dx, dy } = offsets(event);
        const to = dialValueFromPoint(dx, dy, range, shown[active.current] ?? null);
        held.drag(moved(shown, active.current, to));
    };

    const end = DIAL_START + DIAL_SWEEP;
    const angles = shown.map((point) => angleFromValue(point, range));
    // The coloured part: from the start to the target, or between the two ends.
    const filled =
        angles.length === 2
            ? arcPath(CENTER, CENTER, RADIUS, angles[0]!, angles[1]!)
            : angles.length === 1 && angles[0]! > DIAL_START + 0.5
              ? arcPath(CENTER, CENTER, RADIUS, DIAL_START, angles[0]!)
              : null;
    const room = current === null ? null : pointAt(CENTER, CENTER, RADIUS, angleFromValue(current, range));
    const names = dual ? [lowLabel ?? label, highLabel ?? label] : [label];

    return (
        <div
            className={cn(
                "relative mx-auto aspect-square w-full max-w-[17.5rem] select-none",
                disabled && "opacity-60",
                className
            )}
        >
            <svg
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                className={cn("size-full touch-none", disabled ? "cursor-not-allowed" : "cursor-pointer")}
                onPointerDown={start}
                onPointerMove={drag}
                onPointerUp={() => {
                    if (held.holding()) held.release();
                }}
                onPointerCancel={() => held.cancel()}
                onLostPointerCapture={() => {
                    if (held.holding()) held.release();
                }}
            >
                <path
                    d={arcPath(CENTER, CENTER, RADIUS, DIAL_START, end)}
                    fill="none"
                    stroke="hsl(var(--muted))"
                    strokeWidth={STROKE}
                    strokeLinecap="round"
                />
                {filled ? (
                    <path
                        d={filled}
                        fill="none"
                        stroke={color}
                        strokeWidth={STROKE}
                        strokeLinecap="round"
                        opacity={0.9}
                    />
                ) : null}
                {room ? (
                    <circle
                        cx={room.x}
                        cy={room.y}
                        r={4}
                        fill="hsl(var(--foreground))"
                        opacity={0.7}
                        aria-hidden="true"
                    />
                ) : null}
                {shown.map((point, index) => {
                    const at = pointAt(CENTER, CENTER, RADIUS, angles[index]!);
                    return (
                        <g
                            key={names[index]}
                            role="slider"
                            tabIndex={disabled ? -1 : 0}
                            aria-label={names[index]}
                            aria-valuemin={range.min}
                            aria-valuemax={range.max}
                            aria-valuenow={point}
                            aria-valuetext={valueText(point)}
                            aria-disabled={disabled || undefined}
                            aria-describedby={describedBy}
                            className="outline-none"
                            onFocus={() => setFocused(index)}
                            onBlur={() => {
                                setFocused(null);
                                held.flush();
                            }}
                            onKeyDown={(event) => {
                                if (disabled) return;
                                const next = keyedValue(point, event.key, range, event.shiftKey);
                                if (next === null) return;
                                event.preventDefault();
                                held.nudge(moved(shown, index, next));
                            }}
                        >
                            {focused === index ? (
                                <circle
                                    cx={at.x}
                                    cy={at.y}
                                    r={STROKE / 2 + 6}
                                    fill="none"
                                    stroke="hsl(var(--ring))"
                                    strokeWidth={3}
                                />
                            ) : null}
                            {/* 44px to a finger at the dial's full size. */}
                            <circle cx={at.x} cy={at.y} r={STROKE / 2 + 8} fill="transparent" />
                            <circle
                                cx={at.x}
                                cy={at.y}
                                r={STROKE / 2 - 3}
                                fill="white"
                                stroke={color}
                                strokeWidth={3}
                            />
                        </g>
                    );
                })}
            </svg>
            {children ? (
                <div className="pointer-events-none absolute inset-[22%] flex flex-col items-center justify-center gap-1 text-center [&_button]:pointer-events-auto [&_input]:pointer-events-auto">
                    {children}
                </div>
            ) : null}
        </div>
    );
}
