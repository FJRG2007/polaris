"use client";

/**
 * Where everybody sits, against two things at once.
 *
 * The chart a marketing team draws to see where a market is crowded and where
 * nobody is - and the reason a comparison is worth keeping as a structured thing
 * rather than as a document: the same answers that fill the table place the
 * points, with nobody retyping anything or maintaining a second picture that
 * quietly disagrees with the first.
 *
 * Drawn as plain elements rather than on a canvas or with a chart library.
 * Twelve dots in a square is not a charting problem, and what this buys is
 * everything a canvas would have had to be given back: the labels are text a
 * screen reader reads and a browser searches, the whole thing prints, and it
 * costs nothing to load.
 *
 * The arithmetic - which axis covers what, who cannot be placed - is pure and
 * lives in `@polaris/core`, tested there. This is the picture.
 */

import * as core from "@polaris/core";
import { Crosshair } from "lucide-react";
import { useMemo, useState } from "react";
import { cn, EmptyState, Select } from "@polaris/ui";

export function PositioningMap({
    subjects,
    criteria,
    cells
}: {
    subjects: readonly core.Subject[];
    criteria: readonly core.Criterion[];
    cells: ReadonlyMap<string, core.Cell>;
}) {
    /** Only what has a position on a line. A sentence cannot be an axis, and
     *  offering it would be offering a chart that cannot be drawn. */
    const axes = useMemo(
        () => criteria.filter((one) => core.isAxisKind(one.kind)),
        [criteria]
    );
    const [across, setAcross] = useState("");
    const [up, setUp] = useState("");

    // The first two that can be axes, until somebody says otherwise. A chart
    // that opens empty with two dropdowns is a chart nobody draws.
    const acrossId = across || axes[0]?.id || "";
    const upId = up || axes.find((one) => one.id !== acrossId)?.id || "";
    const acrossName = axes.find((one) => one.id === acrossId)?.name ?? "";
    const upName = axes.find((one) => one.id === upId)?.name ?? "";

    const map = useMemo(
        () => core.perceptualMap(subjects, cells, acrossId, upId),
        [subjects, cells, acrossId, upId]
    );

    if (axes.length < 2) {
        return (
            <EmptyState
                icon={<Crosshair className="size-5 shrink-0" aria-hidden />}
                title="Two things to measure"
                description="A positioning map needs two criteria with a number behind them - a rating, a price, a count. Add a second and it draws itself."
            />
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-[12px] text-muted-foreground">Across</span>
                    <Select
                        value={acrossId}
                        onValueChange={setAcross}
                        options={axes.map((one) => ({ value: one.id, label: one.name }))}
                    />
                </label>
                <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-[12px] text-muted-foreground">Up</span>
                    <Select
                        value={upId}
                        onValueChange={setUp}
                        options={axes.map((one) => ({ value: one.id, label: one.name }))}
                    />
                </label>
            </div>

            <div className="flex gap-2">
                {/* The upward axis, written up the side. Rotated rather than set
                    letter by letter, so it is one string a screen reader reads
                    and a browser finds. */}
                <div className="flex shrink-0 items-center">
                    <span
                        className="whitespace-nowrap text-[12px] text-muted-foreground"
                        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                    >
                        {upName}
                    </span>
                </div>

                <div className="min-w-0 flex-1">
                    <div
                        className="relative aspect-[4/3] w-full rounded-lg border border-border bg-surface"
                        role="img"
                        aria-label={`${subjects.length} compared on ${acrossName} and ${upName}`}
                    >
                        {/* The two lines through the middle. What makes it four
                            quadrants rather than a scatter plot, which is the
                            whole reason anybody draws one of these. */}
                        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
                        <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-border" />

                        {map.points.map((point) => (
                            <div
                                key={point.subject.id}
                                className="absolute -translate-x-1/2 translate-y-1/2"
                                style={{
                                    left: `${point.left * 100}%`,
                                    bottom: `${point.up * 100}%`
                                }}
                            >
                                <div className="flex flex-col items-center gap-1">
                                    <span
                                        className={cn(
                                            "size-3 shrink-0 rounded-full ring-2 ring-background",
                                            // Us, told apart at a glance. The
                                            // question anybody opens this to
                                            // answer is where WE are.
                                            point.subject.us ? "bg-primary" : "bg-foreground-subtle"
                                        )}
                                        aria-hidden
                                    />
                                    <span
                                        className="max-w-[9rem] truncate rounded bg-background/90 px-1 text-[11px] font-medium"
                                        title={
                                            point.subject.does
                                                ? `${point.subject.name} - ${point.subject.does}`
                                                : point.subject.name
                                        }
                                    >
                                        {point.subject.name}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="mt-1 flex items-center justify-between text-[11px] text-foreground-subtle">
                        <span>{formatEnd(map.across.low)}</span>
                        <span className="text-[12px] text-muted-foreground">{acrossName}</span>
                        <span>{formatEnd(map.across.high)}</span>
                    </div>
                </div>
            </div>

            {map.missing > 0 ? (
                <p className="text-[12px] text-muted-foreground">
                    {map.missing} {map.missing === 1 ? "competitor is" : "competitors are"} not on
                    the map, because {map.missing === 1 ? "they have" : "they have"} no answer for
                    one of these two. Nothing is placed at zero: not knowing is not the same as
                    scoring nothing.
                </p>
            ) : null}

            {/* What each of them does, under the picture. A point on a chart is a
                dot with a brand name on it until somebody says what the brand
                is, and this is the line a reader coming back in six months
                needs. */}
            {subjects.some((one) => one.does.trim()) ? (
                <ul className="flex flex-col gap-1 border-t border-border pt-3">
                    {subjects
                        .filter((one) => one.does.trim())
                        .map((one) => (
                            <li key={one.id} className="flex gap-2 text-[12px]">
                                <span
                                    className={cn(
                                        "mt-1.5 size-2 shrink-0 rounded-full",
                                        one.us ? "bg-primary" : "bg-foreground-subtle"
                                    )}
                                    aria-hidden
                                />
                                <span className="min-w-0">
                                    <span className="font-medium">{one.name}</span>
                                    <span className="text-muted-foreground"> - {one.does}</span>
                                </span>
                            </li>
                        ))}
                </ul>
            ) : null}
        </div>
    );
}

/** An axis end, short enough to sit under a chart. Rounded rather than exact:
 *  the number is there to say roughly what the axis covers, and four decimal
 *  places under a picture is noise. */
function formatEnd(value: number): string {
    if (!Number.isFinite(value)) return "";
    return Math.abs(value) >= 1000
        ? `${Math.round(value / 100) / 10}k`
        : String(Math.round(value * 10) / 10);
}
