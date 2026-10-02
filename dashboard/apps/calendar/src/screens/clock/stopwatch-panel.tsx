"use client";

/**
 * The stopwatch: start, pause, resume, laps and reset, kept on the server so it
 * keeps counting through a reload and reads the same on another device. Laps
 * list each one's own time and the running total, the fastest and slowest
 * marked; they copy as text and export as CSV.
 *
 * Space starts and pauses, L takes a lap, R resets a paused one - while focus
 * is not in a field.
 */

import { useCalendarT } from "../i18n";
import { useEffect, useState } from "react";
import * as model from "../../lib/clock/model";
import { mutate, type ClockRead } from "./store";
import * as clockActions from "../../actions/clock";
import { Button, cn, Skeleton, useToast } from "@polaris/ui";
import { Copy, Download, Flag, Pause, Play, RotateCcw } from "lucide-react";

type Change = "start" | "pause" | "reset" | "lap";

/** The reading, redrawn every frame while it runs. */
function useReading(watch: model.StopwatchView | null, skew: number): number {
    const [now, setNow] = useState(() => Date.now() + skew);
    const running = watch?.startedAt != null;
    useEffect(() => {
        setNow(Date.now() + skew);
        if (!running) return;
        let frame = 0;
        const draw = () => {
            setNow(Date.now() + skew);
            frame = window.requestAnimationFrame(draw);
        };
        frame = window.requestAnimationFrame(draw);
        return () => window.cancelAnimationFrame(frame);
    }, [running, skew]);
    return watch ? model.stopwatchElapsed(watch, now) : 0;
}

/** The laps as CSV: number, lap time, total, in milliseconds and as read. */
export function lapsCsv(laps: readonly number[], headers: readonly [string, string, string]): string {
    const splits = model.lapSplits(laps);
    const rows = laps.map((total, index) =>
        [index + 1, model.formatClockMs(splits[index]!, { hundredths: true }), model.formatClockMs(total, { hundredths: true })].join(",")
    );
    const lines = [headers.join(","), ...rows, ""];
    return lines.join("\n");
}

export function StopwatchPanel({ clock }: { clock: ClockRead }) {
    const t = useCalendarT();
    const toast = useToast();
    const watch = clock.snapshot?.stopwatch ?? null;
    const reading = useReading(watch, clock.skew);
    const running = watch?.startedAt != null;
    const laps = watch?.laps ?? [];
    const splits = model.lapSplits(laps);
    // The lap in progress counts too, the way a phone's stopwatch shows it.
    const current = reading - (laps[laps.length - 1] ?? 0);
    const fastest = laps.length >= 2 ? Math.min(...splits) : null;
    const slowest = laps.length >= 2 ? Math.max(...splits) : null;
    const failed = (message: string) => toast.show({ key: "calendar-time", title: message || t("screen.failed") });

    const change = (kind: Change) => {
        const at = Date.now() + clock.skew;
        void mutate(
            clock,
            () => clockActions.changeStopwatchAction({ change: kind }),
            (snapshot) => {
                const now = snapshot.stopwatch;
                const elapsed = model.stopwatchElapsed(now, at);
                const next: model.StopwatchView =
                    kind === "start"
                        ? { ...now, startedAt: new Date(at).toISOString() }
                        : kind === "pause"
                          ? { ...now, startedAt: null, elapsedMs: elapsed }
                          : kind === "reset"
                            ? model.EMPTY_STOPWATCH
                            : { ...now, laps: [...now.laps, Math.round(elapsed)] };
                return { ...snapshot, stopwatch: next };
            },
            failed
        );
    };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
            if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], button, [role='menu']")) return;
            if (!watch) return;
            const key = event.key.toLowerCase();
            if (key === " ") {
                event.preventDefault();
                change(running ? "pause" : "start");
            } else if (key === "l" && running) change("lap");
            else if (key === "r" && !running && (watch.elapsedMs > 0 || laps.length > 0)) change("reset");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    const headers: [string, string, string] = [t("time.stopwatch.lap"), t("time.stopwatch.lapTime"), t("time.stopwatch.total")];

    const copy = async () => {
        const text = laps
            .map((total, index) =>
                t("time.stopwatch.copyLine", {
                    lap: index + 1,
                    time: model.formatClockMs(splits[index]!, { hundredths: true }),
                    total: model.formatClockMs(total, { hundredths: true })
                })
            )
            .join("\n");
        try {
            await navigator.clipboard.writeText(text);
            toast.show({ key: "calendar-time", title: t("time.stopwatch.copied") });
        } catch {
            failed(t("time.stopwatch.copyFailed"));
        }
    };

    const exportCsv = () => {
        const blob = new Blob([lapsCsv(laps, headers)], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${t("time.stopwatch.fileName")}.csv`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return (
        <section aria-label={t("time.tabs.stopwatch")} className="mx-auto flex w-full max-w-xl flex-col gap-4">
            <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-card px-4 py-8">
                {watch === null && !clock.error ? (
                    <Skeleton className="h-14 w-64" />
                ) : (
                    <p className="text-5xl font-semibold tabular-nums tracking-tight sm:text-6xl" role="timer" aria-live="off">
                        {model.formatClockMs(reading, { hundredths: true })}
                    </p>
                )}
                {clock.error && watch === null ? (
                    <div role="alert" className="flex items-center gap-2 text-sm">
                        <p className="text-muted-foreground">{t("time.loadFailed")}</p>
                        <Button size="sm" variant="outline" onClick={clock.refresh}>
                            {t("screen.retry")}
                        </Button>
                    </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-center gap-2">
                    {running ? (
                        <>
                            <Button variant="outline" onClick={() => change("lap")} title={t("time.stopwatch.lapKey")} disabled={laps.length >= model.MAX_LAPS}>
                                <Flag />
                                {t("time.stopwatch.lap")}
                            </Button>
                            <Button onClick={() => change("pause")} title={t("time.stopwatch.spaceKey")}>
                                <Pause />
                                {t("time.pause")}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                variant="outline"
                                onClick={() => change("reset")}
                                disabled={!watch || (watch.elapsedMs === 0 && laps.length === 0)}
                                title={t("time.stopwatch.resetKey")}
                            >
                                <RotateCcw />
                                {t("time.reset")}
                            </Button>
                            <Button onClick={() => change("start")} disabled={!watch} title={t("time.stopwatch.spaceKey")}>
                                <Play />
                                {watch && watch.elapsedMs > 0 ? t("time.resume") : t("time.start")}
                            </Button>
                        </>
                    )}
                </div>
            </div>

            {laps.length > 0 ? (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
                            {t("time.stopwatch.laps", { count: laps.length })}
                        </p>
                        <Button size="icon-sm" variant="ghost" aria-label={t("time.stopwatch.copy")} title={t("time.stopwatch.copy")} onClick={() => void copy()}>
                            <Copy />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label={t("time.stopwatch.export")} title={t("time.stopwatch.export")} onClick={exportCsv}>
                            <Download />
                        </Button>
                    </div>
                    <div className="overflow-hidden rounded-lg border border-border bg-card">
                        <table className="w-full text-[0.8125rem] tabular-nums">
                            <thead>
                                <tr className="border-b border-border">
                                    <th className="px-3 py-2 text-left">{headers[0]}</th>
                                    <th className="px-3 py-2 text-right">{headers[1]}</th>
                                    <th className="px-3 py-2 text-right">{headers[2]}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {running ? (
                                    <tr className="border-b border-border text-muted-foreground">
                                        <td className="px-3 py-1.5">{laps.length + 1}</td>
                                        <td className="px-3 py-1.5 text-right">{model.formatClockMs(current, { hundredths: true })}</td>
                                        <td className="px-3 py-1.5 text-right">{model.formatClockMs(reading, { hundredths: true })}</td>
                                    </tr>
                                ) : null}
                                {laps
                                    .map((total, index) => ({ total, index, split: splits[index]! }))
                                    .reverse()
                                    .map(({ total, index, split }) => (
                                        <tr key={index} className="border-b border-border last:border-0">
                                            <td className="px-3 py-1.5">{index + 1}</td>
                                            <td
                                                className={cn(
                                                    "px-3 py-1.5 text-right",
                                                    split === fastest && "font-medium text-success-ink",
                                                    split === slowest && "font-medium text-danger"
                                                )}
                                                title={
                                                    split === fastest
                                                        ? t("time.stopwatch.fastest")
                                                        : split === slowest
                                                          ? t("time.stopwatch.slowest")
                                                          : undefined
                                                }
                                            >
                                                {model.formatClockMs(split, { hundredths: true })}
                                            </td>
                                            <td className="px-3 py-1.5 text-right">{model.formatClockMs(total, { hundredths: true })}</td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : null}
        </section>
    );
}
