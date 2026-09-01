"use client";

/**
 * The list of windows, and the dialog that writes one.
 *
 * Every row says what it does in the words the picker uses - "Invisible, 00:00
 * to 09:00, every day" - because a schedule is read far more often than it is
 * written, and a row that has to be opened to find out what it does is a row
 * nobody trusts enough to leave switched on.
 *
 * Which one is running right now is worked out in the browser rather than on the
 * server, and after the first paint rather than during it. Two reasons and both
 * matter: the server's answer would be stale within the minute, and one rendered
 * into the markup would disagree with the client's clock and be a hydration
 * mismatch on the boundary of every window.
 */

import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import { PRESENCE_CHOICE_DOTS } from "@/components/presence-dots";
import { CalendarClock, Pencil, Plus, Trash2 } from "lucide-react";
import type { PresenceScheduleView } from "@/lib/presence-schedule-service";
import {
    createScheduleAction,
    deleteScheduleAction,
    setScheduleEnabledAction,
    updateScheduleAction
} from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Switch
} from "@polaris/ui";

/** What a new window starts as: hidden overnight, every day. The most common
 *  thing anybody writes here, so the dialog opens on it already written. */
const BLANK: core.PresenceScheduleInput = {
    presence: "invisible",
    days: core.EVERY_DAY,
    startMinute: 23 * 60,
    endMinute: 7 * 60,
    enabled: true
};

export function ScheduleView({
    schedules,
    timeZone,
    pinned
}: {
    schedules: readonly PresenceScheduleView[];
    /** The clock these are read against - the one chosen in Preferences, or the
     *  one this account's browser reported. "auto" only before either exists. */
    timeZone: string;
    /** Whether that zone was chosen rather than taken from the browser. */
    pinned: boolean;
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [editing, setEditing] = useState<{ id: string | null; draft: core.PresenceScheduleInput } | null>(null);
    const [error, setError] = useState("");
    /** What is switched on, held here so a toggle moves under the finger rather
     *  than after the server has been round. */
    const [turned, setTurned] = useState<Record<string, boolean>>({});

    const weekOrder = useMemo(() => core.weekOrderFrom(format.weekStartsOn), [format.weekStartsOn]);

    // Null until the browser has run, which is what keeps the first paint the
    // same on both sides. Re-read every half minute so a window that opens while
    // this screen is up says so without a reload.
    const [openId, setOpenId] = useState<string | null>(null);
    useEffect(() => {
        const enabledNow = () =>
            core.openWindow(
                schedules.filter((rule) => turned[rule.id] ?? rule.enabled),
                timeZone,
                new Date()
            );
        const read = () => setOpenId(enabledNow()?.rule.id ?? null);
        read();
        const timer = setInterval(read, 30_000);
        return () => clearInterval(timer);
    }, [schedules, timeZone, turned]);

    const save = async (draft: core.PresenceScheduleInput, id: string | null) => {
        setError("");
        const result = await runAction(
            () => (id ? updateScheduleAction(id, draft) : createScheduleAction(draft)),
            setError
        );
        if (!result || result.error) return setError(result?.error ?? error);
        setEditing(null);
        router.refresh();
    };

    const toggle = async (rule: PresenceScheduleView, enabled: boolean) => {
        setTurned((current) => ({ ...current, [rule.id]: enabled }));
        const result = await runAction(() => setScheduleEnabledAction(rule.id, enabled), setError);
        // Back where it was: a switch that stayed where it was put after a
        // refused write is the screen telling somebody they are hidden tonight
        // when they are not.
        if (!result || result.error) {
            setTurned((current) => ({ ...current, [rule.id]: rule.enabled }));
            if (result?.error) setError(result.error);
            return;
        }
        router.refresh();
    };

    const remove = async (rule: PresenceScheduleView) => {
        const ok = await confirm({
            title: "Delete this schedule?",
            description: `${core.describeSchedule(rule, weekOrder)}. This cannot be undone - to keep it for later, switch it off instead.`,
            confirmLabel: "Delete",
            danger: true
        });
        if (!ok) return;
        const result = await runAction(() => deleteScheduleAction(rule.id), setError);
        if (result?.error) return setError(result.error);
        router.refresh();
    };

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-3 p-3">
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-[0.6875rem] leading-snug text-foreground-subtle">
                            {core.scheduleZoneIsAssumed(timeZone) ? (
                                <>
                                    These run on the clock of whichever machine Polaris is on. Pick
                                    a timezone in Preferences to be sure they run on yours.
                                </>
                            ) : pinned ? (
                                <>Times are read on your own clock ({timeZone}).</>
                            ) : (
                                // Worth saying, because it is the one thing that moves these
                                // hours without anybody editing them: a zone taken from the
                                // browser follows the browser abroad.
                                <>
                                    Times are read on this browser&apos;s clock ({timeZone}). Pick a
                                    timezone in Preferences to keep them on one.
                                </>
                            )}
                        </p>
                        <Button
                            size="sm"
                            className="shrink-0"
                            onClick={() => setEditing({ id: null, draft: BLANK })}
                        >
                            <Plus className="size-4" />
                            New schedule
                        </Button>
                    </div>

                    {schedules.length === 0 ? (
                        <EmptyState
                            icon={<CalendarClock className="size-5" />}
                            title="No schedules yet"
                            description="Set the hours you are asleep, heads down, or off for the weekend, and stop setting them by hand twice a day."
                        />
                    ) : (
                        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                            {schedules.map((rule) => {
                                const enabled = turned[rule.id] ?? rule.enabled;
                                return (
                                    <li
                                        key={rule.id}
                                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={cn(
                                                "size-2 shrink-0 rounded-full",
                                                PRESENCE_CHOICE_DOTS[rule.presence],
                                                !enabled && "opacity-40"
                                            )}
                                        />
                                        <span className={cn("min-w-[12rem] flex-1", !enabled && "opacity-60")}>
                                            <span className="block text-[0.8125rem]">
                                                {core.PRESENCE_LABELS[rule.presence]}, {core.clockTime(rule.startMinute)} to{" "}
                                                {core.clockTime(rule.endMinute)}
                                                {rule.endMinute <= rule.startMinute ? " the next day" : ""}
                                            </span>
                                            <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                                                {core.nameDays(rule.days, weekOrder)}
                                            </span>
                                        </span>
                                        {openId === rule.id && enabled ? (
                                            <Badge variant="success">Running now</Badge>
                                        ) : null}
                                        <Switch
                                            checked={enabled}
                                            aria-label={`Use this schedule (${core.describeSchedule(rule, weekOrder)})`}
                                            onChange={(next) => void toggle(rule, next)}
                                        />
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            title="Edit"
                                            aria-label={`Edit ${core.describeSchedule(rule, weekOrder)}`}
                                            onClick={() => setEditing({ id: rule.id, draft: rule })}
                                        >
                                            <Pencil className="size-4" />
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            title="Delete"
                                            aria-label={`Delete ${core.describeSchedule(rule, weekOrder)}`}
                                            onClick={() => void remove(rule)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                </CardBody>
            </Card>

            {editing ? (
                <ScheduleDialog
                    key={editing.id ?? "new"}
                    weekOrder={weekOrder}
                    editing={editing.id !== null}
                    initial={editing.draft}
                    onClose={() => setEditing(null)}
                    onSave={(draft) => save(draft, editing.id)}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

/**
 * Writing one window.
 *
 * The days are a row of seven toggles rather than a list of checkboxes, in this
 * account's own week order, with the three sets anybody actually means offered
 * above them. Under it all, the rule in the words it will be read in - because
 * the one thing somebody wants to know before pressing Save is whether 23:00 to
 * 07:00 means what they think it means.
 */
function ScheduleDialog({
    initial,
    editing,
    weekOrder,
    onSave,
    onClose
}: {
    initial: core.PresenceScheduleInput;
    editing: boolean;
    weekOrder: readonly number[];
    onSave: (draft: core.PresenceScheduleInput) => Promise<void>;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState(initial);
    const [saving, setSaving] = useState(false);

    const change = (patch: Partial<core.PresenceScheduleInput>) =>
        setDraft((current) => ({ ...current, ...patch }));

    const checked = core.presenceScheduleSchema.safeParse(draft);
    const problem = checked.success ? "" : (checked.error.issues[0]?.message ?? "");
    // Nothing to save is not something to offer: an edit put back where it
    // started is the same window, and Save would write it again for nothing.
    const changed = JSON.stringify(draft) !== JSON.stringify(initial);

    const submit = async () => {
        if (!checked.success || !changed) return;
        setSaving(true);
        await onSave(checked.data);
        setSaving(false);
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{editing ? "Edit schedule" : "New schedule"}</DialogTitle>
                    <DialogDescription>
                        What you appear as, and the hours it runs.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">Appear as</span>
                        <Select
                            value={draft.presence}
                            aria-label="What to appear as"
                            options={core.SCHEDULED_PRESENCES.map((presence) => ({
                                value: presence,
                                label: core.PRESENCE_LABELS[presence]
                            }))}
                            onValueChange={(value) =>
                                change({ presence: value as core.ScheduledPresence })
                            }
                        />
                    </label>

                    <div className="flex gap-2">
                        <label className="flex flex-1 flex-col gap-1">
                            <span className="text-xs text-muted-foreground">From</span>
                            <Input
                                type="time"
                                value={core.clockTime(draft.startMinute)}
                                onChange={(event) => {
                                    const minute = core.clockMinute(event.target.value);
                                    if (minute !== null) change({ startMinute: minute });
                                }}
                            />
                        </label>
                        <label className="flex flex-1 flex-col gap-1">
                            <span className="text-xs text-muted-foreground">Until</span>
                            <Input
                                type="time"
                                value={core.clockTime(draft.endMinute)}
                                onChange={(event) => {
                                    const minute = core.clockMinute(event.target.value);
                                    if (minute !== null) change({ endMinute: minute });
                                }}
                            />
                        </label>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                            On these days <span aria-hidden="true">*</span>
                        </span>
                        <div className="flex flex-wrap gap-1">
                            {weekOrder.map((day) => {
                                const on = core.runsOnDay(draft.days, day);
                                return (
                                    <button
                                        key={day}
                                        type="button"
                                        aria-pressed={on}
                                        onClick={() => change({ days: core.toggleDay(draft.days, day) })}
                                        className={cn(
                                            "h-8 min-w-[2.75rem] rounded-md border px-2 text-xs transition-colors duration-fast",
                                            on
                                                ? "border-primary bg-primary text-primary-foreground"
                                                : "border-border text-muted-foreground hover:bg-muted"
                                        )}
                                    >
                                        {core.DAY_SHORT_NAMES[day]}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex gap-1">
                            {[
                                { label: "Every day", days: core.EVERY_DAY },
                                { label: "Weekdays", days: core.WEEKDAYS },
                                { label: "Weekends", days: core.WEEKEND }
                            ].map((preset) => (
                                <Button
                                    key={preset.label}
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[0.6875rem]"
                                    onClick={() => change({ days: preset.days })}
                                >
                                    {preset.label}
                                </Button>
                            ))}
                        </div>
                    </div>

                    <p className="text-[0.6875rem] leading-snug text-foreground-subtle">
                        {problem || summarize(draft, weekOrder)}
                    </p>
                </div>
                <DialogFooter>
                    <Button variant="ghost" disabled={saving} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        disabled={saving}
                        aria-disabled={!checked.success || !changed}
                        onClick={() => void submit()}
                    >
                        {editing ? "Save" : "Add schedule"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The window as a sentence, including the hours it lasts - which is the number
 *  somebody is checking when they wonder whether they wrote it the right way
 *  round. */
function summarize(draft: core.PresenceScheduleInput, weekOrder: readonly number[]): string {
    const length = core.windowLength(draft.startMinute, draft.endMinute);
    const hours = Math.floor(length / 60);
    const minutes = length % 60;
    const spans = [hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ");
    const overnight = draft.endMinute <= draft.startMinute ? ", into the next day" : "";
    return `${core.PRESENCE_LABELS[draft.presence]} for ${spans}${overnight}. ${core.nameDays(draft.days, weekOrder)}.`;
}
