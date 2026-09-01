"use client";

/**
 * What happened to something, drawn the same way wherever it is shown.
 *
 * The wording is not shared, and deliberately: "moved it from Doing to Done" and
 * "changed the PORT variable" are the same row in the database and different
 * sentences to read, so each app hands in its own `describe`. What is shared is
 * the shape - a dated column of lines, newest first, with the person who did it
 * named and the ones with nobody behind them attributed to the system.
 */

import { cn } from "@polaris/ui";
import { History } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import type { ActivityLine } from "@/lib/activity/activity";

export function ActivityFeed({
    lines,
    describe,
    empty = "Nothing has happened here yet.",
    className
}: {
    lines: readonly ActivityLine[];
    /** One line, in this app's own words. */
    describe: (line: ActivityLine) => string;
    empty?: string;
    className?: string;
}) {
    if (lines.length === 0) {
        return (
            <div
                className={cn(
                    "flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10 text-center",
                    className
                )}
            >
                <History className="size-5 text-foreground-subtle" />
                <p className="text-[0.8125rem] text-muted-foreground">{empty}</p>
            </div>
        );
    }

    return (
        <ol className={cn("flex flex-col", className)}>
            {lines.map((line, index) => (
                <li key={line.id} className="flex gap-3">
                    {/* The rail: a dot on the line, and the line itself stopping at
                        the last entry rather than trailing off under it. */}
                    <div className="flex flex-col items-center">
                        <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-border-strong" />
                        {index < lines.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 pb-3">
                        <span className="text-[0.8125rem] text-foreground">{describe(line)}</span>
                        <span className="text-[0.6875rem] text-foreground-subtle">
                            <RelativeTime iso={line.createdAt} />
                        </span>
                    </div>
                </li>
            ))}
        </ol>
    );
}
