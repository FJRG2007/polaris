"use client";

/**
 * A colour wheel for a light: hue around the circle, saturation from the white
 * centre out to the rim - the picker Home Assistant's more-info dialog and the
 * Hue app both use, because one drag picks both at once.
 *
 * Home Assistant's is `ha-hs-color-picker` (Apache-2.0); this is adapted from
 * the idea, not the code.
 *
 * Keyboard: Left and Right turn the hue, Up and Down move the saturation, Shift
 * takes bigger steps. Like the sliders beside it, what it shows moves at once,
 * a drag sends the colour it is let go on and keys are gathered for a moment
 * (`useReleasedValue`).
 */

import { cn, useReleasedValue } from "@polaris/ui";

/** Keys turn a colour quicker than they step a temperature, so they settle sooner. */
const KEY_SETTLE_MS = 400;

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
    // Held as a pair so a pick back onto the light's own colour is seen as one.
    const device: readonly [number, number] | null =
        value === null ? null : [value.hue, value.saturation];
    const held = useReleasedValue(
        device,
        (next) => {
            if (next) onCommit({ hue: next[0], saturation: next[1] });
        },
        { settleMs: KEY_SETTLE_MS }
    );
    const shown: HueSaturation = held.shown
        ? { hue: held.shown[0], saturation: held.shown[1] }
        : { hue: 0, saturation: 0 };
    const pair = (next: HueSaturation) => [next.hue, next.saturation] as const;
    const pick = (event: React.PointerEvent<HTMLDivElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        const radius = Math.min(box.width, box.height) / 2;
        held.drag(
            pair(
                hsFromPoint(
                    event.clientX - (box.left + box.width / 2),
                    event.clientY - (box.top + box.height / 2),
                    radius
                )
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
                    "relative aspect-square w-full max-w-56 touch-none self-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                )}
                style={{ background: WHEEL }}
                onPointerDown={(event) => {
                    if (disabled || event.button > 0) return;
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    pick(event);
                }}
                onPointerMove={(event) => {
                    if (held.holding() && !disabled) pick(event);
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
                    const next = stepHs(shown, event.key, event.shiftKey);
                    if (!next) return;
                    event.preventDefault();
                    held.nudge(pair(next));
                }}
            >
                <span
                    aria-hidden
                    className="pointer-events-none absolute size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
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
