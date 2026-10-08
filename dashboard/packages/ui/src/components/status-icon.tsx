/**
 * The round mark a task's status is drawn with: Tasks' rows and cards, and the
 * Calendar's tasks, so a task reads the same wherever it is.
 */

import * as core from "@polaris/core";
import { cn } from "../lib/cn";

/** The radius of the filled part of an in-progress mark, inside the ring. */
const PIE_RADIUS = 5.2;

/**
 * A wedge of the inner circle, clockwise from twelve.
 *
 * A full turn cannot be drawn as an arc - start and end land on the same point
 * and every renderer draws nothing - so anything at or past a whole turn is the
 * disc itself.
 */
function pieOf(progress: number | null | undefined): string {
    const fraction =
        typeof progress === "number" && Number.isFinite(progress)
            ? Math.min(1, Math.max(0, progress))
            : 0.5;
    if (fraction >= 1) {
        return `M10 ${10 - PIE_RADIUS}A${PIE_RADIUS} ${PIE_RADIUS} 0 1 1 9.99 ${10 - PIE_RADIUS}Z`;
    }
    const angle = fraction * 2 * Math.PI;
    const x = 10 + PIE_RADIUS * Math.sin(angle);
    const y = 10 - PIE_RADIUS * Math.cos(angle);
    const largeArc = fraction > 0.5 ? 1 : 0;
    return `M10 10L10 ${10 - PIE_RADIUS}A${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArc} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
}

/**
 * What a state looks like, as a shape rather than only a colour.
 *
 * One shape per stage of the work, so a row is readable at a glance and stays
 * readable to somebody who cannot tell the colours apart:
 *
 *   - not started: a broken ring, open and clearly empty
 *   - under way: a ring filling up like a clock face, and how far round it has
 *     got is how far through the space's own stages that status sits
 *   - held up: a ring with the middle barred, the way a hold reads everywhere
 *   - done: a solid disc with a tick
 *   - closed: a solid disc with a cross
 *
 * Those last two were one shape until now, and it was the wrong one. Both kinds
 * stop the clock, so both drew the tick - which meant a task somebody cancelled,
 * filed as a duplicate, or decided not to do was shown as a task that had been
 * completed. On a board that is the difference between work that got done and
 * work that got dropped, and the colour was the only thing saying which.
 *
 * The clock face is the one worth explaining. A space that has drawn three
 * stages of work in progress had all three rendered as the same filled circle,
 * so "In progress", "In review" and "Ready to ship" were told apart only by a
 * colour somebody had to have learned. Now the mark says which, and it says it
 * in the direction the work is going. Where the caller does not know the space's
 * stages it falls back to a half-filled one, which is what a single-stage space
 * draws anyway and is what this mark has always meant.
 *
 * Drawn rather than composed out of borders because a dashed CSS border on a
 * 20px circle renders as an uneven smudge, and the tick has to sit dead centre
 * at every size a row, a card and a menu use.
 */
export function StatusIcon({
    color,
    type,
    progress,
    size = 20,
    className,
    markColor = "#fff"
}: {
    color: string;
    type: core.TaskStatusType;
    /** The tick or cross drawn on a done or closed disc. White suits every
     *  status colour; a disc drawn in white ink - a task on a coloured calendar
     *  chip - needs the chip's colour instead, or it is a plain white dot. */
    markColor?: string;
    /**
     * How far through the space's stages of work in progress this status sits,
     * from `core.statusProgress`. Ignored by every other kind, and a half turn
     * when the caller does not know.
     */
    progress?: number | null;
    size?: number;
    className?: string;
}) {
    // Not `isFinishedStatus`: that answers "has the clock stopped", which is
    // true of both, and it is the question this shape must not be asking.
    const done = type === "done";
    const closed = type === "closed";
    return (
        <svg
            aria-hidden
            viewBox="0 0 20 20"
            width={size}
            height={size}
            className={cn("shrink-0", className)}
            style={{ color }}
        >
            {done || closed ? (
                <>
                    <circle cx="10" cy="10" r="9" fill="currentColor" />
                    <path
                        d={
                            done
                                ? "M5.8 10.3l2.7 2.7 5.7-5.7"
                                : "M6.9 6.9l6.2 6.2M13.1 6.9l-6.2 6.2"
                        }
                        fill="none"
                        stroke={markColor}
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </>
            ) : (
                <>
                    <circle
                        cx="10"
                        cy="10"
                        r="8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        // Eight even dashes around the circumference: work that
                        // has not started reads as an outline somebody has yet
                        // to close, not as a state of its own.
                        {...(type === "open"
                            ? { strokeDasharray: "3.6 2.7", strokeLinecap: "round" as const }
                            : {})}
                    />
                    {core.isBlockedStatus(type) ? (
                        <path
                            d="M6.4 10h7.2"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                        />
                    ) : (
                        type !== "open" && <path d={pieOf(progress)} fill="currentColor" />
                    )}
                </>
            )}
        </svg>
    );
}
