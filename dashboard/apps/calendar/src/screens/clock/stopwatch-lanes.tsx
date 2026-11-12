"use client";

/**
 * Several stopwatches at once, beside the main one: each named, started,
 * paused, lapped and reset on its own, or all of them together. "Start all" is
 * one write with one instant on the server, so lanes started together read
 * from exactly the same moment - a race's runners, timed against one gun.
 *
 * Readings come from each lane's start instant and the time counted before it,
 * never from ticks, so they survive a reload, a hidden tab and another device.
 * "Rank" orders them the way a race finishes: stopped lanes by time, quickest
 * first, then those still running.
 */

import { useCalendarT } from "../i18n";
import * as model from "../../lib/clock/model";
import { mutate, type ClockRead } from "./store";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useRef, useState } from "react";
import * as clockActions from "../../actions/clock";
import { Button, cn, Input, useToast } from "@polaris/ui";
import {
    ChevronDown,
    ChevronRight,
    Flag,
    ListOrdered,
    Pause,
    Play,
    Plus,
    RotateCcw,
    Square,
    Trash2
} from "lucide-react";

type LaneRequest =
    | { change: "add"; label: string }
    | { change: "rename"; id: string; label: string }
    | { change: model.LaneChange; id: string }
    | { change: "all"; to: model.LaneBulkChange };

/** One clock for every lane, redrawn each frame while any of them runs. */
function useNowWhile(running: boolean, skew: number): number {
    const [now, setNow] = useState(() => Date.now() + skew);
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
    return now;
}

/** The snapshot as it reads after `request`, before the server answers. */
function optimistic(
    snapshot: model.ClockSnapshot,
    request: LaneRequest,
    at: number
): model.ClockSnapshot {
    const lanes = snapshot.lanes ?? [];
    if (request.change === "add") return snapshot;
    if (request.change === "all")
        return {
            ...snapshot,
            lanes: lanes.map((lane) => model.changedLane(lane, request.to, at))
        };
    if (request.change === "delete")
        return { ...snapshot, lanes: lanes.filter((lane) => lane.id !== request.id) };
    return {
        ...snapshot,
        lanes: lanes.map((lane) => {
            if (lane.id !== request.id) return lane;
            if (request.change === "rename") return { ...lane, label: request.label };
            return model.changedLane(lane, request.change as Exclude<model.LaneChange, "delete">, at);
        })
    };
}

const hundredths = (value: number) => model.formatClockMs(value, { hundredths: true });

function LaneName({
    lane,
    fallback,
    onRename
}: {
    lane: model.StopwatchLaneView;
    fallback: string;
    onRename: (label: string) => void;
}) {
    const t = useCalendarT();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(lane.label);
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (editing) input.current?.select();
    }, [editing]);
    const name = lane.label || fallback;
    if (!editing)
        return (
            <button
                type="button"
                className="min-w-0 max-w-full truncate rounded-sm text-left text-[0.875rem] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={t("time.lanes.rename", { name })}
                onClick={() => {
                    setDraft(lane.label);
                    setEditing(true);
                }}
            >
                {name}
            </button>
        );
    const commit = () => {
        setEditing(false);
        const next = draft.trim().slice(0, model.CLOCK_LABEL_MAX);
        if (next !== lane.label) onRename(next);
    };
    return (
        <Input
            ref={input}
            value={draft}
            maxLength={model.CLOCK_LABEL_MAX}
            aria-label={t("time.lanes.nameLabel")}
            placeholder={fallback}
            className="h-8 min-w-0"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === "Enter") commit();
                else if (event.key === "Escape") {
                    event.preventDefault();
                    setEditing(false);
                }
            }}
        />
    );
}

export function StopwatchLanes({ clock }: { clock: ClockRead }) {
    const t = useCalendarT();
    const toast = useToast();
    const [confirm, confirmNode] = hostUi.confirmDialog.useConfirm();
    const lanes = clock.snapshot?.lanes ?? [];
    const anyRunning = lanes.some((lane) => lane.startedAt !== null);
    const now = useNowWhile(anyRunning, clock.skew);
    const [ranked, setRanked] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const failed = (message: string) =>
        toast.show({ key: "calendar-time", title: message || t("screen.failed") });

    const send = (request: LaneRequest) => {
        const at = Date.now() + clock.skew;
        return mutate(
            clock,
            () => clockActions.changeLaneAction(request),
            (snapshot) => optimistic(snapshot, request, at),
            failed
        );
    };

    const fallback = (index: number) => t("time.lanes.defaultName", { number: index + 1 });
    const order = new Map(lanes.map((lane, index) => [lane.id, index]));
    const shown = ranked ? model.rankLanes(lanes, now) : lanes;
    const anyStopped = lanes.some((lane) => lane.startedAt === null);
    const anyTime = lanes.some((lane) => lane.elapsedMs > 0 || lane.startedAt !== null);

    const resetAll = async () => {
        const sure = await confirm({
            title: t("time.lanes.resetAllTitle"),
            description: t("time.lanes.resetAllBody"),
            confirmLabel: t("time.lanes.resetAll"),
            danger: true
        });
        if (sure) void send({ change: "all", to: "reset" });
    };

    const remove = async (lane: model.StopwatchLaneView, name: string) => {
        if (lane.elapsedMs > 0 || lane.startedAt !== null) {
            const sure = await confirm({
                title: t("time.lanes.removeTitle", { name }),
                description: t("time.lanes.removeBody"),
                confirmLabel: t("time.lanes.remove"),
                danger: true
            });
            if (!sure) return;
        }
        void send({ change: "delete", id: lane.id });
    };

    return (
        <section aria-label={t("time.lanes.title")} className="flex flex-col gap-2">
            {confirmNode}
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
                    {t("time.lanes.title")}
                </h2>
                {lanes.length > 0 ? (
                    <>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={!anyStopped}
                            onClick={() => void send({ change: "all", to: "start" })}
                        >
                            <Play />
                            {t("time.lanes.startAll")}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={!anyRunning}
                            onClick={() => void send({ change: "all", to: "pause" })}
                        >
                            <Square />
                            {t("time.lanes.stopAll")}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={!anyTime}
                            onClick={() => void resetAll()}
                        >
                            <RotateCcw />
                            {t("time.lanes.resetAll")}
                        </Button>
                        <Button
                            size="sm"
                            variant={ranked ? "secondary" : "ghost"}
                            aria-pressed={ranked}
                            onClick={() => setRanked(!ranked)}
                        >
                            <ListOrdered />
                            {t("time.lanes.rank")}
                        </Button>
                    </>
                ) : null}
                <Button
                    size="sm"
                    disabled={!clock.snapshot || lanes.length >= model.MAX_LANES}
                    title={
                        lanes.length >= model.MAX_LANES
                            ? t("time.errors.tooManyLanes")
                            : undefined
                    }
                    onClick={() =>
                        void send({ change: "add", label: fallback(lanes.length) })
                    }
                >
                    <Plus />
                    {t("time.lanes.add")}
                </Button>
            </div>
            {lanes.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("time.lanes.empty")}</p>
            ) : (
                <ol className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {shown.map((lane, position) => {
                        const index = order.get(lane.id) ?? position;
                        const name = lane.label || fallback(index);
                        const reading = model.stopwatchElapsed(lane, now);
                        const running = lane.startedAt !== null;
                        const splits = model.lapSplits(lane.laps);
                        const expanded = open.has(lane.id);
                        const toggle = () => {
                            const next = new Set(open);
                            if (expanded) next.delete(lane.id);
                            else next.add(lane.id);
                            setOpen(next);
                        };
                        return (
                            <li key={lane.id} className="flex flex-col gap-1 px-3 py-2 sm:px-4">
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
                                        {ranked ? (
                                            <span
                                                className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                                                aria-label={t("time.lanes.position", {
                                                    position: position + 1
                                                })}
                                            >
                                                {position + 1}
                                            </span>
                                        ) : null}
                                        <div className="flex min-w-0 flex-1 flex-col">
                                            <LaneName
                                                lane={lane}
                                                fallback={fallback(index)}
                                                onRename={(label) =>
                                                    void send({ change: "rename", id: lane.id, label })
                                                }
                                            />
                                            {lane.laps.length > 0 ? (
                                                <button
                                                    type="button"
                                                    className="flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                    aria-expanded={expanded}
                                                    onClick={toggle}
                                                >
                                                    {expanded ? (
                                                        <ChevronDown className="size-3 shrink-0" />
                                                    ) : (
                                                        <ChevronRight className="size-3 shrink-0" />
                                                    )}
                                                    {t("time.stopwatch.laps", {
                                                        count: lane.laps.length
                                                    })}
                                                </button>
                                            ) : null}
                                        </div>
                                    </div>
                                    <p
                                        className={cn(
                                            "shrink-0 text-xl font-semibold tabular-nums tracking-tight",
                                            !running && reading === 0 && "text-muted-foreground"
                                        )}
                                        role="timer"
                                        aria-live="off"
                                        aria-label={t("time.lanes.reading", {
                                            name,
                                            time: hundredths(reading)
                                        })}
                                    >
                                        {hundredths(reading)}
                                    </p>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {running ? (
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                aria-label={t("time.lanes.lapOf", { name })}
                                                title={t("time.stopwatch.lap")}
                                                disabled={lane.laps.length >= model.MAX_LAPS}
                                                onClick={() =>
                                                    void send({ change: "lap", id: lane.id })
                                                }
                                            >
                                                <Flag />
                                            </Button>
                                        ) : (
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                aria-label={t("time.lanes.resetOf", { name })}
                                                title={t("time.reset")}
                                                disabled={
                                                    lane.elapsedMs === 0 && lane.laps.length === 0
                                                }
                                                onClick={() =>
                                                    void send({ change: "reset", id: lane.id })
                                                }
                                            >
                                                <RotateCcw />
                                            </Button>
                                        )}
                                        <Button
                                            size="icon-sm"
                                            variant={running ? "primary" : "outline"}
                                            aria-label={
                                                running
                                                    ? t("time.lanes.pauseOf", { name })
                                                    : t("time.lanes.startOf", { name })
                                            }
                                            title={
                                                running
                                                    ? t("time.pause")
                                                    : lane.elapsedMs > 0
                                                      ? t("time.resume")
                                                      : t("time.start")
                                            }
                                            onClick={() =>
                                                void send({
                                                    change: running ? "pause" : "start",
                                                    id: lane.id
                                                })
                                            }
                                        >
                                            {running ? <Pause /> : <Play />}
                                        </Button>
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            aria-label={t("time.lanes.removeOf", { name })}
                                            title={t("time.lanes.remove")}
                                            onClick={() => void remove(lane, name)}
                                        >
                                            <Trash2 />
                                        </Button>
                                    </div>
                                </div>
                                {expanded && lane.laps.length > 0 ? (
                                    <ol className="flex flex-col gap-0.5 pl-6 text-xs tabular-nums text-muted-foreground">
                                        {lane.laps.map((total, lap) => (
                                            <li key={lap} className="flex gap-3">
                                                <span className="w-10 shrink-0">
                                                    {t("time.lanes.lapNumber", { lap: lap + 1 })}
                                                </span>
                                                <span className="w-20 shrink-0 text-right">
                                                    {hundredths(splits[lap]!)}
                                                </span>
                                                <span className="min-w-0 truncate text-right">
                                                    {hundredths(total)}
                                                </span>
                                            </li>
                                        ))}
                                    </ol>
                                ) : null}
                            </li>
                        );
                    })}
                </ol>
            )}
        </section>
    );
}
