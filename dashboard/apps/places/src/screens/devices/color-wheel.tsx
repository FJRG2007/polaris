"use client";

/**
 * A colour wheel for a light: hue around the circle, saturation from the white
 * centre out to the rim - the picker Home Assistant's more-info dialog and the
 * Hue app both use, because one drag picks both at once.
 *
 * Keyboard: Left and Right turn the hue, Up and Down move the saturation, Shift
 * takes bigger steps. Like the sliders beside it, what it shows moves at once
 * and is sent once the drag has been still for a moment.
 */

import { cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";

const SETTLE_MS = 400;

export interface HueSaturation {
    readonly hue: number;
    readonly saturation: number;
}

/** Where on the wheel a colour sits, as a fraction of the radius from the
 *  centre: x to the right, y downwards. Hue 0 is at the top, turning clockwise,
 *  which is where the CSS conic gradient below starts it. */
export function pointFromHs({ hue, saturation }: HueSaturation): { x: number; y: number } {
    const angle = (hue * Math.PI) / 180;
    const r = Math.min(Math.max(saturation, 0), 100) / 100;
    return { x: Math.sin(angle) * r, y: -Math.cos(angle) * r };
}

/** The colour under a point, given as offsets from the centre in the same unit
 *  as the radius. A point past the rim is the rim. */
export function hsFromPoint(dx: number, dy: number, radius: number): HueSaturation {
    if (radius <= 0 || (dx === 0 && dy === 0)) return { hue: 0, saturation: 0 };
    const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const distance = Math.min(Math.hypot(dx, dy) / radius, 1);
    return { hue: Math.round((degrees + 360) % 360), saturation: Math.round(distance * 100) };
}

/** The colour after one key, or null for a key the wheel does not take. */
export function stepHs(value: HueSaturation, key: string, big: boolean): HueSaturation | null {
    const by = big ? 15 : 5;
    switch (key) {
        case "ArrowRight":
            return { ...value, hue: (value.hue + by) % 360 };
        case "ArrowLeft":
            return { ...value, hue: (value.hue - by + 360) % 360 };
        case "ArrowUp":
            return { ...value, saturation: Math.min(value.saturation + by, 100) };
        case "ArrowDown":
            return { ...value, saturation: Math.max(value.saturation - by, 0) };
        default:
            return null;
    }
}

const WHEEL =
    "radial-gradient(circle closest-side, #fff, rgb(255 255 255 / 0)), conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";

export function ColorWheel({
    label,
    valueText,
    value,
    disabled,
    onCommit,
    className
}: {
    label: string;
    /** What a screen reader says for a colour, in the reader's language. */
    valueText: (value: HueSaturation) => string;
    value: HueSaturation | null;
    disabled: boolean;
    onCommit: (value: HueSaturation) => void;
    className?: string;
}) {
    const [shown, setShown] = useState<HueSaturation>(value ?? { hue: 0, saturation: 0 });
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pending = useRef<HueSaturation | null>(null);
    const dragging = useRef(false);
    const commit = useRef(onCommit);
    commit.current = onCommit;
    // A later sync wins over a pick that has already been sent.
    const syncedHue = value?.hue ?? null;
    const syncedSaturation = value?.saturation ?? null;
    useEffect(() => {
        if (syncedHue === null || syncedSaturation === null) return;
        if (!timer.current && !dragging.current)
            setShown({ hue: syncedHue, saturation: syncedSaturation });
    }, [syncedHue, syncedSaturation]);
    const flush = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        if (next) commit.current(next);
    };
    useEffect(() => () => flush(), []);
    const change = (next: HueSaturation) => {
        setShown(next);
        pending.current = next;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, SETTLE_MS);
    };
    const pick = (event: React.PointerEvent<HTMLDivElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        const radius = Math.min(box.width, box.height) / 2;
        change(
            hsFromPoint(
                event.clientX - (box.left + box.width / 2),
                event.clientY - (box.top + box.height / 2),
                radius
            )
        );
    };
    const point = pointFromHs(shown);
    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            <span className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate" title={label}>
                    {label}
                </span>
                <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-full border border-border"
                    style={{ background: `hsl(${shown.hue} 100% ${100 - shown.saturation / 2}%)` }}
                />
            </span>
            <div
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label={label}
                aria-disabled={disabled || undefined}
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={shown.hue}
                aria-valuetext={valueText(shown)}
                className={cn(
                    "relative aspect-square w-full max-w-48 touch-none self-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                )}
                style={{ background: WHEEL }}
                onPointerDown={(event) => {
                    if (disabled) return;
                    dragging.current = true;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    pick(event);
                }}
                onPointerMove={(event) => {
                    if (dragging.current && !disabled) pick(event);
                }}
                onPointerUp={() => {
                    dragging.current = false;
                }}
                onPointerCancel={() => {
                    dragging.current = false;
                }}
                onKeyDown={(event) => {
                    if (disabled) return;
                    const next = stepHs(shown, event.key, event.shiftKey);
                    if (!next) return;
                    event.preventDefault();
                    change(next);
                }}
            >
                <span
                    aria-hidden
                    className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
                    style={{
                        left: `${50 + point.x * 50}%`,
                        top: `${50 + point.y * 50}%`,
                        background: `hsl(${shown.hue} 100% ${100 - shown.saturation / 2}%)`
                    }}
                />
            </div>
        </div>
    );
}
