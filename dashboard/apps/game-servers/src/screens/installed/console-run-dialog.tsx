"use client";

/**
 * Running a kept command that asks for something - which player, or a value of
 * the person's own - or scheduling one.
 *
 * Every field is checked as it is typed by the schema the server runs it with
 * (`console-vars`), and an empty field is incomplete rather than wrong: it is
 * marked, and Run waits for it. Scheduling fixes the values now; who "every
 * player online" is, is worked out each time it runs.
 */

import { useMemo, useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Select,
    DateInput
} from "@polaris/ui";
import * as vars from "../../lib/console-vars";
import * as plan from "../../lib/console-schedule";
import { useGameText, useSchemaText } from "../game-text";
import { commandPreview, type SavedCommand } from "../../lib/console-commands";
import type { MinecraftEdition } from "../../lib/minecraft/service";
import { PlayerPicker } from "./player-picker";
import { REPEAT_DRAFT, RepeatFields, readRepeatDraft, type RepeatDraft } from "./console-repeats";
import type { RepeatPlan } from "../../lib/console-repeat";

/** What one run is given. */
export interface RunChoice {
    readonly values: Record<string, string>;
    readonly target: vars.RunTarget | null;
    /** Run it this many times, so far apart; absent for once. */
    readonly repeatPlan?: RepeatPlan;
}

/** What scheduling it is given on top. */
export interface ScheduleChoice extends RunChoice {
    /** The first moment as this browser reckons it. */
    readonly firstAt: string;
    /** Or, for "in ...", how long from now: counted again by the server, whose
     *  clock is the one the sweep runs on. */
    readonly startIn?: plan.Span;
    readonly repeat: plan.ScheduleRepeat;
}

type RepeatKind = plan.ScheduleRepeat["kind"];
/** How the first run is picked: one of the quick "in ..." choices (minutes),
 *  "in" so many of a unit, or a date and time. */
type StartKind = `${(typeof plan.START_PRESETS)[number]}` | "in" | "at";

/** A moment as a `datetime-local` field reads it, in this browser's time. */
function localInput(at: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Five minutes from now, on the minute: the first moment a schedule is worth
 *  setting for, and the one most people would have typed. */
function soon(): string {
    const at = new Date(Date.now() + 5 * 60_000);
    at.setSeconds(0, 0);
    return localInput(at);
}

/** A whole number as typed, or NaN for anything else - so "1.5" and "2e1" are
 *  refused by the schema rather than read as something nobody typed. */
function wholeNumber(raw: string): number {
    return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

export function RunCommandDialog({
    entry,
    mode,
    repeatOn = false,
    edition,
    players,
    pending,
    error,
    onClose,
    onRun,
    onSchedule
}: {
    entry: SavedCommand;
    mode: "run" | "schedule";
    /** Open with Repeat already switched on. */
    repeatOn?: boolean;
    edition: MinecraftEdition | null;
    /** Who is on, to pick from. */
    players: readonly string[];
    pending: boolean;
    error: string;
    onClose: () => void;
    onRun: (choice: RunChoice) => void;
    onSchedule: (choice: ScheduleChoice) => void;
}) {
    const t = useGameText("games");
    const schemaText = useSchemaText();
    const custom = entry.variables ?? [];
    const uses = useMemo(
        () => vars.commandUses(entry.command, edition, custom),
        [entry.command, edition, custom]
    );

    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(uses.custom.map((declared) => [declared.name, declared.initial]))
    );
    const [every, setEvery] = useState(true);
    // Nobody is picked for them: a command run on the wrong player is worse
    // than one more click.
    const [player, setPlayer] = useState("");
    const [startKind, setStartKind] = useState<StartKind>("5");
    const [startAmount, setStartAmount] = useState("30");
    const [startUnit, setStartUnit] = useState<plan.SpanUnit>("minutes");
    const [firstAt, setFirstAt] = useState(soon);
    const [repeatKind, setRepeatKind] = useState<RepeatKind>("once");
    const [gap, setGap] = useState("10");
    const [unit, setUnit] = useState<plan.SpanUnit>("minutes");
    const [times, setTimes] = useState("3");
    const [repeatDraft, setRepeatDraft] = useState<RepeatDraft>(() => ({
        ...REPEAT_DRAFT,
        on: repeatOn
    }));
    const repeatRead =
        mode === "run"
            ? readRepeatDraft(repeatDraft)
            : { plan: null, missing: false, problem: null };

    // Each field against the schema the server uses. Empty is "not yet", shown
    // by the asterisk and the waiting button, never as an error under the field.
    const problems = Object.fromEntries(
        uses.custom.map((declared) => {
            const raw = values[declared.name] ?? "";
            if (raw.trim().length === 0) return [declared.name, null];
            const checked = vars.runValueSchema(declared).safeParse(raw);
            return [
                declared.name,
                checked.success ? null : (checked.error.issues[0]?.message ?? null)
            ];
        })
    );
    // Left empty, a value with a default is sent with the default.
    const missing = uses.custom.some(
        (declared) =>
            declared.initial.length === 0 && (values[declared.name] ?? "").trim().length === 0
    );
    const playerProblem =
        uses.perPlayer && !every && player.trim().length > 0
            ? vars.valueProblem("player", vars.normalizeValue("player", player))
            : null;
    const playerMissing = uses.perPlayer && !every && player.trim().length === 0;

    // The gap and the "in ..." are each checked by the schema the server uses;
    // an empty one is not yet, like every other field here.
    const gapSpan: plan.Span = { amount: wholeNumber(gap), unit };
    const gapMissing = repeatKind !== "once" && gap.trim().length === 0;
    const minutes = plan.spanMinutes(gapSpan);
    const repeat: plan.ScheduleRepeat =
        repeatKind === "once"
            ? { kind: "once" }
            : repeatKind === "every"
              ? { kind: "every", minutes }
              : { kind: "times", minutes, times: Number(times) };
    const startIn: plan.Span | undefined =
        startKind === "at"
            ? undefined
            : startKind === "in"
              ? { amount: wholeNumber(startAmount), unit: startUnit }
              : plan.spanOf(Number(startKind));
    const startMissing = startKind === "in" && startAmount.trim().length === 0;
    const now = new Date();
    const startsAt = startIn ? plan.startAfter(startIn, now) : new Date(firstAt);
    const scheduleProblem =
        mode !== "schedule" || gapMissing || startMissing
            ? null
            : ((repeatKind !== "once" ? plan.spanProblem(plan.everySchema, gapSpan) : null) ??
              plan.repeatProblem(repeat) ??
              (startIn ? plan.spanProblem(plan.startInSchema, startIn) : null) ??
              plan.startProblem(startsAt, now));

    const ready =
        !pending &&
        !missing &&
        !playerMissing &&
        !playerProblem &&
        !gapMissing &&
        !startMissing &&
        !scheduleProblem &&
        !repeatRead.missing &&
        !repeatRead.problem &&
        Object.values(problems).every((problem) => problem === null);

    const unitOptions = plan.SPAN_UNITS.map((value) => ({
        value,
        label: t(
            value === "days"
                ? "consoleSchedule.unitDays"
                : value === "hours"
                  ? "consoleSchedule.unitHours"
                  : "consoleSchedule.unitMinutes"
        )
    }));

    function choice(): RunChoice {
        return {
            values: Object.fromEntries(
                uses.custom.map((declared) => [declared.name, values[declared.name] ?? ""])
            ),
            target: uses.perPlayer ? (every ? { every: true } : { player: player.trim() }) : null
        };
    }

    function submit(): void {
        if (!ready) return;
        if (mode === "run")
            onRun(repeatRead.plan ? { ...choice(), repeatPlan: repeatRead.plan } : choice());
        else
            onSchedule({
                ...choice(),
                firstAt: startsAt.toISOString(),
                ...(startIn ? { startIn } : {}),
                repeat
            });
    }

    return (
        <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="break-words">
                        {mode === "run"
                            ? t("consoleVars.runTitle", { name: entry.label })
                            : t("consoleVars.scheduleTitle", { name: entry.label })}
                    </DialogTitle>
                    {/* One line however long the command is; the whole of it
                        on hover. */}
                    <DialogDescription
                        className="min-w-0 truncate font-mono text-xs"
                        title={entry.command}
                    >
                        {commandPreview(entry.command)}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex min-w-0 flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit();
                    }}
                >
                    {uses.perPlayer && (
                        <div className="flex flex-col gap-1">
                            <span className="text-sm font-medium">{t("consoleVars.runFor")}</span>
                            <SegmentedControl
                                value={every ? "every" : "one"}
                                onValueChange={(value) => setEvery(value === "every")}
                                aria-label={t("consoleVars.runFor")}
                                options={[
                                    { value: "every", label: t("consoleVars.everyPlayer") },
                                    { value: "one", label: t("consoleVars.onePlayer") }
                                ]}
                            />
                            {!every && (
                                <div className="flex min-w-0 flex-col gap-1">
                                    <span className="text-sm" aria-hidden="true">
                                        {t("consoleVars.player")} *
                                    </span>
                                    <PlayerPicker
                                        aria-label={t("consoleVars.player")}
                                        players={players}
                                        value={player}
                                        onValueChange={setPlayer}
                                        allowTyped
                                    />
                                    {players.length === 0 && player.length === 0 && (
                                        <span className="text-xs text-muted-foreground">
                                            {t("consoleVars.errors.nobodyOnType")}
                                        </span>
                                    )}
                                    {playerProblem && (
                                        <span role="alert" className="text-xs text-danger">
                                            {schemaText(playerProblem)}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {uses.custom.map((declared) => {
                        const caption = (
                            <span className="text-sm font-medium">
                                {declared.label}
                                {declared.initial.length === 0 && (
                                    <span aria-hidden="true"> *</span>
                                )}
                                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                                    {`{${declared.name}}`}
                                </span>
                            </span>
                        );
                        const problem = problems[declared.name] ? (
                            <span role="alert" className="text-xs text-danger">
                                {schemaText(problems[declared.name])}
                            </span>
                        ) : null;
                        const set = (value: string) =>
                            setValues((current) => ({ ...current, [declared.name]: value }));
                        // A player is picked from who is on, the same way as the
                        // player a per-player command is run for, or typed.
                        return declared.type === "player" ? (
                            <div key={declared.name} className="flex min-w-0 flex-col gap-1">
                                {caption}
                                <PlayerPicker
                                    aria-label={declared.label}
                                    players={players}
                                    value={values[declared.name] ?? ""}
                                    onValueChange={set}
                                    allowTyped
                                />
                                {problem}
                            </div>
                        ) : (
                            <label key={declared.name} className="flex min-w-0 flex-col gap-1">
                                {caption}
                                <Input
                                    value={values[declared.name] ?? ""}
                                    inputMode={declared.type === "number" ? "decimal" : undefined}
                                    maxLength={vars.MAX_VARIABLE_VALUE}
                                    className={declared.type === "item" ? "font-mono" : undefined}
                                    placeholder={declared.initial || undefined}
                                    aria-required={declared.initial.length === 0 ? true : undefined}
                                    aria-invalid={problems[declared.name] ? true : undefined}
                                    onChange={(event) => set(event.target.value)}
                                />
                                {problem}
                            </label>
                        );
                    })}

                    {mode === "schedule" && (
                        <div className="flex flex-col gap-3 border-t border-border pt-3">
                            {/* Each column is its choice and the fields that choice
                                asks for, so on a phone they read top to bottom in
                                the order they are answered. */}
                            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                                <div className="flex min-w-0 flex-col gap-2">
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <span className="text-sm font-medium">
                                            {t("consoleSchedule.startsAt")}
                                        </span>
                                        <Select
                                            value={startKind}
                                            onValueChange={(value) =>
                                                setStartKind(value as StartKind)
                                            }
                                            options={[
                                                ...plan.START_PRESETS.map((preset) => {
                                                    const span = plan.spanOf(preset);
                                                    return {
                                                        value: String(preset),
                                                        label:
                                                            span.unit === "minutes"
                                                                ? t("consoleSchedule.inMinutes", {
                                                                      count: span.amount
                                                                  })
                                                                : t("consoleSchedule.inHours", {
                                                                      count: span.amount
                                                                  })
                                                    };
                                                }),
                                                {
                                                    value: "in",
                                                    label: t("consoleSchedule.inCustom")
                                                },
                                                { value: "at", label: t("consoleSchedule.atTime") }
                                            ]}
                                            aria-label={t("consoleSchedule.startsAt")}
                                        />
                                    </div>
                                    {startKind === "in" && (
                                        <div className="flex min-w-0 items-end gap-2">
                                            <label className="flex w-20 shrink-0 flex-col gap-1">
                                                <span className="text-sm">
                                                    {t("consoleSchedule.startIn")}
                                                    <span aria-hidden="true"> *</span>
                                                </span>
                                                <Input
                                                    type="number"
                                                    inputMode="numeric"
                                                    min={1}
                                                    step={1}
                                                    value={startAmount}
                                                    aria-required="true"
                                                    onChange={(event) =>
                                                        setStartAmount(event.target.value)
                                                    }
                                                />
                                            </label>
                                            <Select
                                                value={startUnit}
                                                onValueChange={(value) =>
                                                    setStartUnit(value as plan.SpanUnit)
                                                }
                                                options={unitOptions}
                                                aria-label={t("consoleSchedule.startInUnit")}
                                                className="min-w-0 flex-1"
                                            />
                                        </div>
                                    )}
                                    {startKind === "at" && (
                                        <DateInput
                                            mode="datetime"
                                            value={firstAt}
                                            aria-label={t("consoleSchedule.atTime")}
                                            onChange={(event) => setFirstAt(event.target.value)}
                                        />
                                    )}
                                </div>
                                <div className="flex min-w-0 flex-col gap-2">
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <span className="text-sm font-medium">
                                            {t("consoleSchedule.repeat")}
                                        </span>
                                        <Select
                                            value={repeatKind}
                                            onValueChange={(value) =>
                                                setRepeatKind(value as RepeatKind)
                                            }
                                            options={[
                                                { value: "once", label: t("consoleSchedule.once") },
                                                {
                                                    value: "every",
                                                    label: t("consoleSchedule.every")
                                                },
                                                {
                                                    value: "times",
                                                    label: t("consoleSchedule.times")
                                                }
                                            ]}
                                            aria-label={t("consoleSchedule.repeat")}
                                        />
                                    </div>
                                    {repeatKind !== "once" && (
                                        <div className="flex min-w-0 items-end gap-2">
                                            {repeatKind === "times" && (
                                                <label className="flex w-20 shrink-0 flex-col gap-1">
                                                    <span className="text-sm">
                                                        {t("consoleSchedule.count")}
                                                    </span>
                                                    <Input
                                                        type="number"
                                                        min={plan.MIN_TIMES}
                                                        max={plan.MAX_TIMES}
                                                        value={times}
                                                        onChange={(event) =>
                                                            setTimes(event.target.value)
                                                        }
                                                    />
                                                </label>
                                            )}
                                            <label className="flex w-20 shrink-0 flex-col gap-1">
                                                <span className="text-sm">
                                                    {t("consoleSchedule.interval")}
                                                    <span aria-hidden="true"> *</span>
                                                </span>
                                                <Input
                                                    type="number"
                                                    inputMode="numeric"
                                                    min={1}
                                                    step={1}
                                                    value={gap}
                                                    aria-required="true"
                                                    onChange={(event) => setGap(event.target.value)}
                                                />
                                            </label>
                                            <Select
                                                value={unit}
                                                onValueChange={(value) =>
                                                    setUnit(value as plan.SpanUnit)
                                                }
                                                options={unitOptions}
                                                aria-label={t("consoleSchedule.intervalUnit")}
                                                className="min-w-0 flex-1"
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {uses.custom.length > 0 && `${t("consoleSchedule.fixedValues")} `}
                                {`${t("consoleSchedule.precision")} `}
                                {t("consoleSchedule.offlineNote")}
                            </p>
                            {scheduleProblem && (
                                <span role="alert" className="text-xs text-danger">
                                    {schemaText(scheduleProblem)}
                                </span>
                            )}
                        </div>
                    )}

                    {mode === "run" && (
                        <RepeatFields draft={repeatDraft} onChange={setRepeatDraft} />
                    )}

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("console.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={!ready}
                            disabled={pending}
                            className="aria-disabled:opacity-50"
                        >
                            {mode === "schedule"
                                ? t("consoleSchedule.schedule")
                                : repeatRead.plan
                                  ? t("consoleRepeat.start")
                                  : t("console.run")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
