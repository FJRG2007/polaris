"use client";

import { cn } from "@polaris/ui";
import type { ReactNode } from "react";

/**
 * A circular progress ring, drawn over a picture on its way the way WhatsApp
 * and Telegram draw one: the real fraction of the bytes, or a turning arc when
 * there is no number to show (waiting its turn, or the server saving it). The
 * arc does not turn for a reader who asked for less motion.
 *
 * Purely the drawing; whatever pressing it does is the caller's button around it.
 */
export function ProgressRing({
    fraction,
    size = 44,
    children,
    className
}: {
    /** 0..1, or null for the turning arc. */
    fraction: number | null;
    size?: number;
    /** What sits in the middle - the stop cross, a retry arrow. */
    children?: ReactNode;
    className?: string;
}) {
    const stroke = 3;
    const radius = (size - stroke) / 2;
    const around = 2 * Math.PI * radius;
    const shown = fraction === null ? 0.25 : fraction <= 0 ? 0 : Math.max(0.02, Math.min(1, fraction));
    return (
        <span
            className={cn(
                "relative inline-grid place-items-center rounded-full bg-black/55 text-white",
                className
            )}
            style={{ width: size, height: size }}
        >
            <svg
                aria-hidden
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                className={cn(
                    "absolute inset-0 -rotate-90",
                    fraction === null && "animate-spin motion-reduce:animate-none"
                )}
            >
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity={0.25}
                    strokeWidth={stroke}
                />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeDasharray={around}
                    strokeDashoffset={around * (1 - shown)}
                    className="transition-[stroke-dashoffset] duration-200 motion-reduce:transition-none"
                />
            </svg>
            <span className="relative grid place-items-center">{children}</span>
        </span>
    );
}
