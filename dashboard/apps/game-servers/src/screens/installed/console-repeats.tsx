"use client";

/**
 * Running a console command several times: the fields that say how many times
 * and how far apart, and the list of repeats running on this server, with
 * where each one is and a Stop button for anybody who has the console.
 *
 * The fields are checked as they are typed by the schema the server checks
 * them with (`console-repeat`); an empty one is not yet, never an error.
 */

import { useEffect, useState } from "react";
import { Repeat, Square } from "lucide-react";
import * as repeats from "../../lib/console-repeat";
import { Input, Select, Switch, cn } from "@polaris/ui";
import { useGameText, useSchemaText } from "../game-text";

/** The repeat fields as typed. */
export interface RepeatDraft {
    readonly on: boolean;
    readonly times: string;
    readonly every: string;
    readonly unit: repeats.RepeatUnit;
}

export const REPEAT_DRAFT: RepeatDraft = { on: false, times: "5", every: "5", unit: "seconds" };

/** A whole number as typed, or NaN, so "1.5" is refused rather than rounded. */
function whole(raw: string): number {
    return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

/** What a draft asks for: the plan, or why it cannot run yet. Off is no plan. */
export function readRepeatDraft(draft: RepeatDraft): {
    plan: repeats.RepeatPlan | null;
    missing: boolean;
    problem: string | null;
} {
    if (!draft.on) return { plan: null, missing: false, problem: null };
    const missing = draft.times.trim().length === 0 || draft.every.trim().length === 0;
    const plan = { times: whole(draft.times), every: whole(draft.every), unit: draft.unit };
    const problem = missing ? null : repeats.repeatPlanProblem(plan);
    return { plan: missing || problem ? null : plan, missing, problem };
}

export function RepeatFields({
    draft,
    onChange,
    toggle = true
}: {
    draft: RepeatDraft;
    onChange: (draft: RepeatDraft) => void;
    /** Whether it can be switched off; the console's own Repeat is always on. */
    toggle?: boolean;
}) {
    const t = useGameText("games");
    const schemaText = useSchemaText();
    const { problem } = readRepeatDraft(draft);
    const set = (patch: Partial<RepeatDraft>) => onChange({ ...draft, ...patch });
    return (
        <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
            {toggle && (
                <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{t("consoleRepeat.repeat")}</span>
                    <Switch
                        checked={draft.on}
                        onChange={(on) => set({ on })}
                        aria-label={t("consoleRepeat.repeat")}
                    />
                </div>
            )}
            {draft.on && (
                <>
                    <div className="flex min-w-0 items-end gap-2">
                        <label className="flex w-20 shrink-0 flex-col gap-1">
                            <span className="text-sm">
                                {t("consoleRepeat.times")}
                                <span aria-hidden="true"> *</span>
                            </span>
                            <Input
                                type="number"
                                inputMode="numeric"
                                min={repeats.MIN_REPEAT_TIMES}
                                max={repeats.MAX_REPEAT_TIMES}
                                step={1}
                                value={draft.times}
                                aria-required="true"
                                onChange={(event) => set({ times: event.target.value })}
                            />
                        </label>
                        <label className="flex w-20 shrink-0 flex-col gap-1">
                            <span className="text-sm">
                                {t("consoleRepeat.every")}
                                <span aria-hidden="true"> *</span>
                            </span>
                            <Input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                step={1}
                                value={draft.every}
                                aria-required="true"
                                onChange={(event) => set({ every: event.target.value })}
                            />
                        </label>
                        <Select
                            value={draft.unit}
                            onValueChange={(value) => set({ unit: value as repeats.RepeatUnit })}
                            options={repeats.REPEAT_UNITS.map((value) => ({
                                value,
                                label: t(
                                    value === "seconds"
                                        ? "consoleRepeat.unitSeconds"
                                        : "consoleRepeat.unitMinutes"
                                )
                            }))}
                            aria-label={t("consoleRepeat.unit")}
                            className="min-w-0 flex-1"
                        />
                    </div>
                    <p className="text-xs text-muted-foreground">{t("consoleRepeat.note")}</p>
                    {problem && (
                        <span role="alert" className="text-xs text-danger">
                            {schemaText(problem)}
                        </span>
                    )}
                </>
            )}
        </div>
    );
}

/** How each way a repeat can end is said. */
const ENDED = {
    finished: "consoleRepeat.ended.finished",
    stopped: "consoleRepeat.ended.stopped",
    serverStopped: "consoleRepeat.ended.serverStopped",
    noAccess: "consoleRepeat.ended.noAccess"
} as const satisfies Record<repeats.RepeatEnd, string>;

/** Seconds until `at`, never below zero, read against a clock that ticks. */
function secondsUntil(at: number, now: number): number {
    return Math.max(0, Math.ceil((at - now) / 1_000));
}

export function ConsoleRepeats({
    list,
    pending,
    onStop
}: {
    list: readonly repeats.ConsoleRepeatView[];
    pending: boolean;
    onStop: (id: string) => void;
}) {
    const t = useGameText("games");
    const schemaText = useSchemaText();
    const running = list.some((one) => one.ended === null);
    // A clock for the "next in" count, ticking only while something runs.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!running) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [running]);
    if (list.length === 0) return null;
    return (
        <section aria-label={t("consoleRepeat.running")} className="flex flex-col gap-1">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                {t("consoleRepeat.running")}
            </p>
            <ul className="flex flex-col gap-1">
                {list.map((one) => {
                    const label = t("consoleRepeat.stop", { name: one.label });
                    const parts = [
                        t("consoleRepeat.progress", { done: one.done, total: one.total })
                    ];
                    if (one.ended) parts.push(t(ENDED[one.ended]));
                    else if (one.nextAt !== null)
                        parts.push(
                            t("consoleRepeat.nextIn", { seconds: secondsUntil(one.nextAt, now) })
                        );
                    else parts.push(t("consoleRepeat.sendingNow"));
                    parts.push(t("consoleRepeat.by", { name: one.startedBy }));
                    return (
                        <li
                            key={one.id}
                            className={cn(
                                "flex min-w-0 items-start gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-xs",
                                one.ended && "opacity-70"
                            )}
                        >
                            <Repeat
                                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate font-mono" title={one.command}>
                                    {one.label}
                                </span>
                                <span
                                    role={one.ended === null ? "status" : undefined}
                                    className={cn(
                                        "text-muted-foreground",
                                        (one.ended === "serverStopped" ||
                                            one.ended === "noAccess") &&
                                            "text-warning"
                                    )}
                                >
                                    {parts.join(" - ")}
                                </span>
                                {one.lastProblem && (
                                    <span className="break-words text-danger">
                                        {schemaText(one.lastProblem) ?? one.lastProblem}
                                    </span>
                                )}
                            </div>
                            {one.ended === null ? (
                                <button
                                    type="button"
                                    disabled={pending}
                                    onClick={() => onStop(one.id)}
                                    aria-label={label}
                                    title={label}
                                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                    <Square className="size-3.5" />
                                </button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
