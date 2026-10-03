"use client";

/**
 * Timers: several at once, each named, counting down to the same second on
 * every device; presets and the lengths used lately one press away; a minute
 * more on any of them; and focus cycles (Pomodoro) - focus, short break, and a
 * long one every few rounds, each phase starting the next by itself.
 */

import { lengthText } from "./words";
import { useCalendarT } from "../i18n";
import { useMemo, useState } from "react";
import { SoundField } from "./alarms-panel";
import * as model from "../../lib/clock/model";
import { hostUi } from "@polaris/app-host/client";
import * as clockActions from "../../actions/clock";
import { mutate, useServerNow, type ClockRead } from "./store";
import { Button, cn, EmptyState, Input, Skeleton, Switch, useToast } from "@polaris/ui";
import {
    Brain,
    Pause,
    Play,
    Plus,
    RotateCcw,
    Settings2,
    SkipForward,
    Timer,
    Trash2
} from "lucide-react";

const PRESET_MINUTES = [1, 3, 5, 10, 15, 30, 60] as const;

export function TimersPanel({
    clock,
    pomodoro,
    onPomodoro
}: {
    clock: ClockRead;
    pomodoro: model.PomodoroConfig;
    onPomodoro: (config: model.PomodoroConfig) => void;
}) {
    const t = useCalendarT();
    const toast = useToast();
    const timers = clock.snapshot?.timers ?? null;
    const running = timers?.some((timer) => timer.endsAt !== null) ?? false;
    const now = useServerNow(clock.skew, 250, running);
    const failed = (message: string) =>
        toast.show({ key: "calendar-time", title: message || t("screen.failed") });
    const full = timers !== null && timers.length >= model.MAX_TIMERS;

    const recent = useMemo(() => {
        const seen = new Set<number>(PRESET_MINUTES.map((minutes) => minutes * 60_000));
        const lengths: number[] = [];
        for (const timer of [...(timers ?? [])].reverse()) {
            if (timer.pomodoro || seen.has(timer.durationMs)) continue;
            seen.add(timer.durationMs);
            lengths.push(timer.durationMs);
            if (lengths.length === 4) break;
        }
        return lengths;
    }, [timers]);

    const create = (input: model.TimerInput) =>
        mutate(clock, () => clockActions.createTimerAction(input), null, failed);

    const change = (
        timer: model.TimerView,
        change: "start" | "pause" | "reset" | "addMinute" | "skip" | "delete"
    ) =>
        void mutate(
            clock,
            () => clockActions.changeTimerAction({ id: timer.id, change }),
            (snapshot) => ({
                ...snapshot,
                timers:
                    change === "delete"
                        ? snapshot.timers.filter((entry) => entry.id !== timer.id)
                        : snapshot.timers.map((entry) =>
                              entry.id === timer.id ? optimistic(entry, change, now) : entry
                          )
            }),
            failed
        );

    return (
        <section aria-label={t("time.tabs.timers")} className="flex flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-2">
                <NewTimer disabled={full} recent={recent} onCreate={create} />
                <FocusCard
                    key={JSON.stringify(pomodoro)}
                    config={pomodoro}
                    disabled={full}
                    onConfig={onPomodoro}
                    onStart={(config) =>
                        void mutate(
                            clock,
                            () => clockActions.startFocusAction({ config, label: "" }),
                            null,
                            failed
                        )
                    }
                />
            </div>
            {full ? (
                <p className="text-xs text-muted-foreground">
                    {t("time.timers.full", { max: model.MAX_TIMERS })}
                </p>
            ) : null}

            {timers === null ? (
                clock.error ? (
                    <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                        <p className="text-muted-foreground">{t("time.loadFailed")}</p>
                        <Button size="sm" variant="outline" onClick={clock.refresh}>
                            {t("screen.retry")}
                        </Button>
                    </div>
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
                        {[0, 1].map((index) => (
                            <Skeleton key={index} className="h-40 w-full" />
                        ))}
                    </div>
                )
            ) : timers.length === 0 ? (
                <EmptyState
                    icon={<Timer />}
                    title={t("time.timers.emptyTitle")}
                    description={t("time.timers.emptyBody")}
                />
            ) : (
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {timers.map((timer) => (
                        <TimerCard
                            key={timer.id}
                            timer={timer}
                            now={now}
                            onChange={(kind) => change(timer, kind)}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

/** What a change will look like once the server has it, drawn at once. */
function optimistic(
    timer: model.TimerView,
    change: "start" | "pause" | "reset" | "addMinute" | "skip",
    now: number
): model.TimerView {
    const state = model.timerState(timer);
    const left = model.timerRemaining(timer, now);
    if (change === "start" && state !== "running")
        return {
            ...timer,
            endsAt: new Date(now + left).toISOString(),
            remainingMs: null,
            firedAt: null
        };
    if (change === "pause" && state === "running")
        return { ...timer, endsAt: null, remainingMs: left };
    if (change === "reset" && !timer.pomodoro)
        return { ...timer, endsAt: null, remainingMs: null, firedAt: null };
    if (change === "addMinute") {
        if (state === "running")
            return {
                ...timer,
                endsAt: new Date(new Date(timer.endsAt!).getTime() + 60_000).toISOString()
            };
        if (state === "paused") return { ...timer, remainingMs: timer.remainingMs! + 60_000 };
        if (state === "rung")
            return {
                ...timer,
                endsAt: new Date(now + 60_000).toISOString(),
                firedAt: null,
                remainingMs: null
            };
        return {
            ...timer,
            durationMs: Math.min(timer.durationMs + 60_000, model.CLOCK_TIMER_MAX_MS)
        };
    }
    return timer;
}

function TimerCard({
    timer,
    now,
    onChange
}: {
    timer: model.TimerView;
    now: number;
    onChange: (change: "start" | "pause" | "reset" | "addMinute" | "skip" | "delete") => void;
}) {
    const t = useCalendarT();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const state = model.timerState(timer);
    const left = model.timerRemaining(timer, now);
    const cycle = timer.pomodoro;
    const total = Math.max(timer.durationMs, left);
    const done = state === "rung" || (state === "running" && left <= 0);
    const title =
        timer.label ||
        (cycle
            ? t(`time.focus.phase.${cycle.phase}`)
            : t("time.timers.untitled", { length: lengthText(timer.durationMs, t) }));

    return (
        <li
            className={cn(
                "flex flex-col gap-3 rounded-lg border border-border bg-card p-4",
                done && "border-primary"
            )}
        >
            <div className="flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.8125rem] font-medium" title={title}>
                        {title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                        {cycle
                            ? t("time.focus.round", { round: cycle.round, rounds: cycle.rounds })
                            : lengthText(timer.durationMs, t)}
                        {" · "}
                        {done
                            ? t("time.timers.done")
                            : state === "running"
                              ? t("time.timers.running")
                              : state === "paused"
                                ? t("time.timers.paused")
                                : t("time.timers.ready")}
                    </p>
                </div>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("time.delete")}
                    title={t("time.delete")}
                    onClick={async () => {
                        if (
                            state === "running" &&
                            !(await confirm({
                                title: t("time.timers.deleteTitle"),
                                description: t("time.timers.deleteBody"),
                                confirmLabel: t("time.delete"),
                                danger: true
                            }))
                        )
                            return;
                        onChange("delete");
                    }}
                >
                    <Trash2 />
                </Button>
            </div>

            <div
                className="relative h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={title}
                aria-valuemin={0}
                aria-valuemax={Math.round(total / 1000)}
                aria-valuenow={Math.round((total - left) / 1000)}
            >
                <div
                    className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-200"
                    style={{ width: `${total > 0 ? ((total - left) / total) * 100 : 100}%` }}
                />
            </div>

            <p
                className={cn(
                    "text-center text-4xl font-semibold tabular-nums tracking-tight",
                    done && "text-primary",
                    state === "paused" && "text-muted-foreground"
                )}
                aria-live="off"
            >
                {model.formatCountdown(left)}
            </p>

            <div className="flex flex-wrap items-center justify-center gap-1.5">
                {state === "running" && !done ? (
                    <Button size="sm" variant="outline" onClick={() => onChange("pause")}>
                        <Pause />
                        {t("time.pause")}
                    </Button>
                ) : (
                    <Button size="sm" onClick={() => onChange(done ? "reset" : "start")}>
                        {done ? <RotateCcw /> : <Play />}
                        {done
                            ? t("time.timers.restart")
                            : state === "paused"
                              ? t("time.resume")
                              : t("time.start")}
                    </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => onChange("addMinute")}>
                    <Plus />
                    {t("time.timers.addMinute")}
                </Button>
                {cycle ? (
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("time.focus.skip")}
                        title={t("time.focus.skip")}
                        onClick={() => onChange("skip")}
                    >
                        <SkipForward />
                    </Button>
                ) : null}
                {state !== "idle" || cycle ? (
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("time.reset")}
                        title={t("time.reset")}
                        onClick={() => onChange("reset")}
                    >
                        <RotateCcw />
                    </Button>
                ) : null}
            </div>
            {confirmElement}
        </li>
    );
}

function NewTimer({
    disabled,
    recent,
    onCreate
}: {
    disabled: boolean;
    recent: readonly number[];
    onCreate: (input: model.TimerInput) => Promise<boolean>;
}) {
    const t = useCalendarT();
    const [parts, setParts] = useState({ hours: "0", minutes: "5", seconds: "0" });
    const [label, setLabel] = useState("");
    const [sound, setSound] = useState<model.ClockSound>("chime");
    const [busy, setBusy] = useState(false);
    const number = (text: string) => (/^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : NaN);
    const hours = number(parts.hours || "0");
    const minutes = number(parts.minutes || "0");
    const seconds = number(parts.seconds || "0");
    const durationMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
    const check = model.timerInputSchema.safeParse({ label, durationMs, sound, start: true });
    const partInvalid = (value: number, max: number) => Number.isNaN(value) || value > max;
    const tooLong = durationMs > model.CLOCK_TIMER_MAX_MS;

    const start = async (input: model.TimerInput) => {
        if (busy || disabled) return;
        setBusy(true);
        const ok = await onCreate(input);
        setBusy(false);
        if (ok) setLabel("");
    };

    const field = (key: "hours" | "minutes" | "seconds", max: number, text: string) => (
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            <span>{text}</span>
            <Input
                inputMode="numeric"
                value={parts[key]}
                aria-invalid={partInvalid(number(parts[key] || "0"), max) || undefined}
                onChange={(event) =>
                    setParts({
                        ...parts,
                        [key]: event.target.value.replace(/[^\d]/g, "").slice(0, 3)
                    })
                }
                onFocus={(event) => event.currentTarget.select()}
                className="text-center text-lg tabular-nums"
            />
        </label>
    );

    return (
        <form
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
            onSubmit={(event) => {
                event.preventDefault();
                if (check.success) void start(check.data);
            }}
        >
            <p className="text-[0.8125rem] font-medium">{t("time.timers.new")}</p>
            <div className="flex gap-2">
                {field("hours", 99, t("time.timers.hours"))}
                {field("minutes", 59, t("time.timers.minutesField"))}
                {field("seconds", 59, t("time.timers.secondsField"))}
            </div>
            {tooLong ? <p className="text-xs text-danger">{t("time.timers.tooLong")}</p> : null}
            <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={t("time.timers.presets")}
            >
                {PRESET_MINUTES.map((preset) => (
                    <Button
                        key={preset}
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={disabled || busy}
                        title={t("time.timers.startPreset", {
                            length: lengthText(preset * 60_000, t)
                        })}
                        onClick={() =>
                            void start({
                                label: label.trim(),
                                durationMs: preset * 60_000,
                                sound,
                                start: true
                            })
                        }
                    >
                        {t("time.minutesShort", { count: preset })}
                    </Button>
                ))}
                {recent.map((length) => (
                    <Button
                        key={`recent-${length}`}
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={disabled || busy}
                        title={t("time.timers.recent")}
                        onClick={() =>
                            void start({
                                label: label.trim(),
                                durationMs: length,
                                sound,
                                start: true
                            })
                        }
                    >
                        {model.formatClockMs(length)}
                    </Button>
                ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-[0.8125rem]">
                    <span>{t("time.label")}</span>
                    <Input
                        value={label}
                        maxLength={model.CLOCK_LABEL_MAX}
                        placeholder={t("time.timers.labelHint")}
                        onChange={(event) => setLabel(event.target.value)}
                    />
                </label>
                <SoundField value={sound} onChange={setSound} />
            </div>
            <Button
                type="submit"
                className="self-start"
                aria-disabled={!check.success || disabled || busy}
            >
                <Play />
                {t("time.start")}
            </Button>
        </form>
    );
}

function FocusCard({
    config,
    disabled,
    onConfig,
    onStart
}: {
    config: model.PomodoroConfig;
    disabled: boolean;
    onConfig: (config: model.PomodoroConfig) => void;
    onStart: (config: model.PomodoroConfig) => void;
}) {
    const t = useCalendarT();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<Record<"focus" | "short" | "long" | "rounds", string>>({
        focus: String(config.focus),
        short: String(config.short),
        long: String(config.long),
        rounds: String(config.rounds)
    });
    const [auto, setAuto] = useState(config.auto);
    const parsed = model.pomodoroConfigSchema.safeParse({
        focus: Number(draft.focus),
        short: Number(draft.short),
        long: Number(draft.long),
        rounds: Number(draft.rounds),
        auto
    });
    const changed =
        parsed.success &&
        JSON.stringify(parsed.data) !== JSON.stringify(model.pomodoroConfigSchema.parse(config));
    const field = (key: keyof typeof draft, text: string, max: number, min = 1) => {
        const value = Number(draft[key]);
        const bad = !/^\d+$/.test(draft[key]) || value < min || value > max;
        return (
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <span className="truncate" title={text}>
                    {text}
                </span>
                <Input
                    inputMode="numeric"
                    value={draft[key]}
                    aria-invalid={bad || undefined}
                    onChange={(event) =>
                        setDraft({
                            ...draft,
                            [key]: event.target.value.replace(/[^\d]/g, "").slice(0, 3)
                        })
                    }
                    className="tabular-nums"
                />
            </label>
        );
    };

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
                <Brain aria-hidden className="size-4 text-muted-foreground" />
                <p className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
                    {t("time.focus.title")}
                </p>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("time.focus.settings")}
                    title={t("time.focus.settings")}
                    aria-expanded={editing}
                    onClick={() => setEditing(!editing)}
                >
                    <Settings2 />
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                {t("time.focus.summary", {
                    focus: config.focus,
                    short: config.short,
                    long: config.long,
                    rounds: config.rounds
                })}
            </p>
            {editing ? (
                <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {field("focus", t("time.focus.focusMinutes"), 180)}
                        {field("short", t("time.focus.shortMinutes"), 60)}
                        {field("long", t("time.focus.longMinutes"), 120)}
                        {field("rounds", t("time.focus.rounds"), 12, 2)}
                    </div>
                    <label className="flex items-center gap-2 text-[0.8125rem]">
                        <Switch
                            checked={auto}
                            onChange={setAuto}
                            aria-label={t("time.focus.auto")}
                        />
                        <span>{t("time.focus.auto")}</span>
                    </label>
                    <Button
                        size="sm"
                        variant="outline"
                        className="self-start"
                        aria-disabled={!changed}
                        onClick={() => {
                            if (parsed.success && changed) {
                                onConfig(parsed.data);
                                setEditing(false);
                            }
                        }}
                    >
                        {t("time.save")}
                    </Button>
                </div>
            ) : null}
            <Button className="self-start" disabled={disabled} onClick={() => onStart(config)}>
                <Play />
                {t("time.focus.start")}
            </Button>
        </div>
    );
}
