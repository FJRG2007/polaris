"use client";

/**
 * A big slider you drag: brightness, volume, a blind's position, a fan's speed,
 * a humidity target. The whole bar is the handle - press anywhere and drag -
 * and it fills to the value, the way Home Assistant's `ha-control-slider` and
 * the Google Home and Apple Home tiles work, rather than a thin native range
 * input with a thumb too small for a thumb. Adapted from Home Assistant's
 * frontend (Apache-2.0), not copied.
 *
 * Every value shown while dragging is on the device's own step; only the one it
 * is let go on is sent (`useReleasedValue`). Keys follow the WAI-ARIA slider
 * pattern and are gathered for a moment before they are sent. Horizontal ones
 * leave vertical swipes to the page so a list can still be scrolled past them.
 */

import { cn } from "../lib/cn";
import { useReleasedValue } from "../lib/use-released-value";
import { fractionOf, keyedValue, valueAt, type ValueRange } from "../lib/control-values";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";

export interface ControlSliderProps extends ValueRange {
    /** The device's own value; null when it has not said. */
    value: number | null;
    /** The accessible name. */
    label: string;
    /** What a screen reader says for a value, in the reader's language. */
    valueText?: (value: number) => string;
    orientation?: "horizontal" | "vertical";
    /** `fill` grows from the start (brightness); `cursor` marks a point on a
     *  track that is itself the scale (colour temperature). */
    mode?: "fill" | "cursor";
    /** A CSS background for the track, such as a warm-to-cold gradient. */
    track?: string;
    disabled?: boolean;
    describedBy?: string;
    /** Sent once, when the drag is let go of or the keys have been still. */
    onCommit: (value: number) => void;
    /** The value being shown while one is held, or null once it is the device's again. */
    onLive?: (value: number | null) => void;
    settleMs?: number;
    /** Drawn inside the bar, over the fill: the value or an icon. */
    children?: ReactNode;
    className?: string;
}

export function ControlSlider({
    value,
    min,
    max,
    step,
    label,
    valueText,
    orientation = "horizontal",
    mode = "fill",
    track,
    disabled = false,
    describedBy,
    onCommit,
    onLive,
    settleMs,
    children,
    className
}: ControlSliderProps) {
    const range = { min, max, step };
    const held = useReleasedValue<number | null>(
        value,
        (next) => {
            if (next !== null) onCommit(next);
        },
        { settleMs, onLive }
    );
    const shown = held.shown;
    const vertical = orientation === "vertical";
    const fraction = shown === null ? 0 : fractionOf(shown, range);

    const at = (event: ReactPointerEvent<HTMLDivElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        const along = vertical
            ? box.height > 0
                ? (box.bottom - event.clientY) / box.height
                : 0
            : box.width > 0
              ? (event.clientX - box.left) / box.width
              : 0;
        return valueAt(along, range);
    };

    const percent = `${fraction * 100}%`;
    const fillStyle: CSSProperties = vertical ? { height: percent } : { width: percent };
    const cursorStyle: CSSProperties = vertical
        ? { bottom: `calc(${percent} - ${fraction * 0.5}rem)` }
        : { left: `calc(${percent} - ${fraction * 0.5}rem)` };

    return (
        <div
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={label}
            aria-orientation={orientation}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={shown ?? undefined}
            aria-valuetext={shown !== null && valueText ? valueText(shown) : undefined}
            aria-disabled={disabled || undefined}
            aria-describedby={describedBy}
            className={cn(
                "relative isolate select-none overflow-hidden rounded-xl bg-muted outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                vertical ? "h-56 w-24 touch-pan-x" : "h-11 w-full min-w-0 touch-pan-y",
                disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                className
            )}
            style={track ? { background: track } : undefined}
            onPointerDown={(event) => {
                if (disabled || event.button > 0) return;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                held.drag(at(event));
            }}
            onPointerMove={(event) => {
                if (!disabled && held.holding()) held.drag(at(event));
            }}
            onPointerUp={() => {
                if (held.holding()) held.release();
            }}
            onPointerCancel={() => held.cancel()}
            onLostPointerCapture={() => {
                if (held.holding()) held.release();
            }}
            onBlur={() => held.flush()}
            onKeyDown={(event) => {
                if (disabled) return;
                const next = keyedValue(shown, event.key, range, event.shiftKey);
                if (next === null) return;
                event.preventDefault();
                held.nudge(next);
            }}
        >
            {mode === "fill" && !track ? (
                <span
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute bg-primary transition-[width,height] duration-fast",
                        vertical ? "inset-x-0 bottom-0" : "inset-y-0 left-0"
                    )}
                    style={fillStyle}
                />
            ) : null}
            {shown !== null ? (
                <span
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute rounded-full",
                        mode === "cursor" || track
                            ? "border-2 border-white bg-white/30 shadow-[0_0_0_1px_rgb(0_0_0/0.35)]"
                            : "bg-primary-foreground/80",
                        vertical ? "inset-x-3 h-2" : "inset-y-2 w-2",
                        mode === "fill" && !track && (vertical ? "-translate-y-3" : "-translate-x-3")
                    )}
                    style={cursorStyle}
                />
            ) : null}
            {children ? (
                <span
                    className={cn(
                        "pointer-events-none relative z-10 flex h-full items-center gap-2 px-3 text-sm font-medium tabular-nums",
                        vertical && "flex-col justify-end pb-4"
                    )}
                >
                    {children}
                </span>
            ) : null}
        </div>
    );
}
