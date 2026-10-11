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
    Select
} from "@polaris/ui";
import * as vars from "../../lib/console-vars";
import * as plan from "../../lib/console-schedule";
import { useGameText, useSchemaText } from "../game-text";
import type { SavedCommand } from "../../lib/console-commands";
import type { MinecraftEdition } from "../../lib/minecraft/service";

/** What one run is given. */
export interface RunChoice {
    readonly values: Record<string, string>;
    readonly target: vars.RunTarget | null;
}

/** What scheduling it is given on top. */
export interface ScheduleChoice extends RunChoice {
    readonly firstAt: string;
    readonly repeat: plan.ScheduleRepeat;
}

type RepeatKind = plan.ScheduleRepeat["kind"];
type Unit = "minutes" | "hours";

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

export function RunCommandDialog({
    entry,
    mode,
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
    const [player, setPlayer] = useState(players[0] ?? "");
    const [firstAt, setFirstAt] = useState(soon);
    const [repeatKind, setRepeatKind] = useState<RepeatKind>("once");
    const [gap, setGap] = useState("10");
    const [unit, setUnit] = useState<Unit>("minutes");
    const [times, setTimes] = useState("3");

    // Each field against the schema the server uses. Empty is "not yet", shown
    // by the asterisk and the waiting button, never as an error under the field.
    const problems = Object.fromEntries(
        uses.custom.map((declared) => {
            const raw = values[declared.name] ?? "";
            if (raw.trim().length === 0) return [declared.name, null];
            const checked = vars.valueSchema(declared.type).safeParse(raw);
            return [
                declared.name,
                checked.success ? null : (checked.error.issues[0]?.message ?? null)
            ];
        })
    );
    const missing = uses.custom.some(
        (declared) => (values[declared.name] ?? "").trim().length === 0
    );
    const playerProblem =
        uses.perPlayer && !every && player.trim().length > 0
            ? vars.valueProblem("player", vars.normalizeValue("player", player))
            : null;
    const playerMissing = uses.perPlayer && !every && player.trim().length === 0;

    const minutes = Number(gap) * (unit === "hours" ? 60 : 1);
    const repeat: plan.ScheduleRepeat =
        repeatKind === "once"
            ? { kind: "once" }
            : repeatKind === "every"
              ? { kind: "every", minutes }
              : { kind: "times", minutes, times: Number(times) };
    const startsAt = new Date(firstAt);
    const scheduleProblem =
        mode === "schedule"
            ? (plan.repeatProblem(repeat) ?? plan.startProblem(startsAt, new Date()))
            : null;

    const ready =
        !pending &&
        !missing &&
        !playerMissing &&
        !playerProblem &&
        !scheduleProblem &&
        Object.values(problems).every((problem) => problem === null);

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
        if (mode === "run") onRun(choice());
        else onSchedule({ ...choice(), firstAt: startsAt.toISOString(), repeat });
    }

    return (
        <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {mode === "run"
                            ? t("consoleVars.runTitle", { name: entry.label })
                            : t("consoleVars.scheduleTitle", { name: entry.label })}
                    </DialogTitle>
                    <DialogDescription className="break-all font-mono text-xs">
                        {entry.command}
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
                                <label className="flex flex-col gap-1">
                                    <span className="text-sm">
                                        {t("consoleVars.player")}
                                        <span aria-hidden="true"> *</span>
                                    </span>
                                    <Input
                                        value={player}
                                        list="console-run-players"
                                        maxLength={vars.MAX_VARIABLE_VALUE}
                                        placeholder={t("consoleVars.playerPlaceholder")}
                                        aria-invalid={playerProblem ? true : undefined}
                                        onChange={(event) => setPlayer(event.target.value)}
                                    />
                                    {playerProblem && (
                                        <span role="alert" className="text-xs text-danger">
                                            {schemaText(playerProblem)}
                                        </span>
                                    )}
                                </label>
                            )}
                        </div>
                    )}

                    {uses.custom.map((declared) => (
                        <label key={declared.name} className="flex flex-col gap-1">
                            <span className="text-sm font-medium">
                                {declared.label}
                                <span aria-hidden="true"> *</span>
                                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                                    {`{${declared.name}}`}
                                </span>
                            </span>
                            <Input
                                value={values[declared.name] ?? ""}
                                inputMode={declared.type === "number" ? "decimal" : undefined}
                                list={
                                    declared.type === "player" ? "console-run-players" : undefined
                                }
                                maxLength={vars.MAX_VARIABLE_VALUE}
                                className={declared.type === "item" ? "font-mono" : undefined}
                                aria-required="true"
                                aria-invalid={problems[declared.name] ? true : undefined}
                                onChange={(event) =>
                                    setValues((current) => ({
                                        ...current,
                                        [declared.name]: event.target.value
                                    }))
                                }
                            />
                            {problems[declared.name] && (
                                <span role="alert" className="text-xs text-danger">
                                    {schemaText(problems[declared.name])}
                                </span>
                            )}
                        </label>
                    ))}
                    <datalist id="console-run-players">
                        {players.map((name) => (
                            <option key={name} value={name} />
                        ))}
                    </datalist>

                    {mode === "schedule" && (
                        <div className="flex flex-col gap-3 border-t border-border pt-3">
                            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                                <label className="flex flex-col gap-1">
                                    <span className="text-sm font-medium">
                                        {t("consoleSchedule.startsAt")}
                                    </span>
                                    <Input
                                        type="datetime-local"
                                        value={firstAt}
                                        onChange={(event) => setFirstAt(event.target.value)}
                                    />
                                </label>
                                <div className="flex flex-col gap-1">
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
                                            { value: "every", label: t("consoleSchedule.every") },
                                            { value: "times", label: t("consoleSchedule.times") }
                                        ]}
                                        aria-label={t("consoleSchedule.repeat")}
                                    />
                                </div>
                            </div>
                            {repeatKind !== "once" && (
                                <div className="flex flex-wrap items-end gap-2">
                                    {repeatKind === "times" && (
                                        <label className="flex w-24 flex-col gap-1">
                                            <span className="text-sm">
                                                {t("consoleSchedule.count")}
                                            </span>
                                            <Input
                                                type="number"
                                                min={plan.MIN_TIMES}
                                                max={plan.MAX_TIMES}
                                                value={times}
                                                onChange={(event) => setTimes(event.target.value)}
                                            />
                                        </label>
                                    )}
                                    <label className="flex w-24 flex-col gap-1">
                                        <span className="text-sm">
                                            {t("consoleSchedule.interval")}
                                        </span>
                                        <Input
                                            type="number"
                                            min={1}
                                            value={gap}
                                            onChange={(event) => setGap(event.target.value)}
                                        />
                                    </label>
                                    <Select
                                        value={unit}
                                        onValueChange={(value) => setUnit(value as Unit)}
                                        options={[
                                            {
                                                value: "minutes",
                                                label: t("consoleSchedule.unitMinutes")
                                            },
                                            {
                                                value: "hours",
                                                label: t("consoleSchedule.unitHours")
                                            }
                                        ]}
                                        aria-label={t("consoleSchedule.interval")}
                                    />
                                </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {uses.custom.length > 0 && `${t("consoleSchedule.fixedValues")} `}
                                {t("consoleSchedule.offlineNote")}
                            </p>
                            {scheduleProblem && (
                                <span role="alert" className="text-xs text-danger">
                                    {schemaText(scheduleProblem)}
                                </span>
                            )}
                        </div>
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
                            {mode === "run" ? t("console.run") : t("consoleSchedule.schedule")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
