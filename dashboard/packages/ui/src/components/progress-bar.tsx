/**
 * A progress bar: a track and a fill, with a light sweeping along the fill while
 * the work is moving, so a bar that only ticks every few seconds still reads as
 * alive. `value` is a percentage; `null` is work with no number to give yet, and
 * draws a short pulsing stripe instead of a fill that pretends to know.
 * Accessibility attributes (`aria-label`, `aria-valuenow`, ...) pass through to
 * the track, which carries `role="progressbar"`.
 */

import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const TONES = {
    primary: "bg-primary",
    warning: "bg-warning",
    danger: "bg-danger",
    foreground: "bg-foreground"
} as const;

export type ProgressTone = keyof typeof TONES;

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
    /** Percentage filled, clamped to 0-100. `null` when there is no number yet. */
    value: number | null;
    tone?: ProgressTone;
    /** The moving light. Off for a bar that is not moving: a paused timer, a meter. */
    animated?: boolean;
    /** Classes for the fill, e.g. a slower width transition. */
    fillClassName?: string;
}

export function ProgressBar({
    value,
    tone = "primary",
    animated = true,
    className,
    fillClassName,
    ...props
}: ProgressBarProps) {
    const width = value === null ? null : Math.min(100, Math.max(0, value));
    return (
        <div
            role="progressbar"
            className={cn("relative block h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
            {...props}
        >
            <div
                className={cn(
                    "h-full rounded-full",
                    TONES[tone],
                    width === null ? "w-1/3 animate-pulse" : "transition-[width] duration-200",
                    animated && width !== null && width > 0 && width < 100 && "progress-shimmer",
                    fillClassName
                )}
                style={width === null ? undefined : { width: `${width}%` }}
            />
        </div>
    );
}
