"use client";

/**
 * Making a calendar, or changing one: its name, colour, description, time
 * zone, whether it holds tasks, the reminders its new events start with, and -
 * for its owner - whether its alarms ring and whether it ever makes you busy.
 * Somebody a calendar is shared with changes only the colour they see it in.
 */

import { X } from "lucide-react";
import * as engine from "../engine";
import { unwrap } from "./cached-read";
import { ZonePicker } from "./zone-picker";
import { FieldRow, GroupHeading } from "./ui";
import { useCalendarT, useRuleT } from "./i18n";
import * as calendarActions from "../actions/calendars";
import { useEffect, useId, useMemo, useState } from "react";
import type { CalendarSummary, DefaultAlarms } from "../lib/wire";
import { CALENDAR_COLORS, calendarInputSchema, calendarPatchSchema } from "../lib/schemas";
import {
    Button,
    cn,
    ColorPicker,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    Textarea,
    useToast
} from "@polaris/ui";

export type CalendarDialogTarget =
    | { readonly kind: "new"; readonly withTasks: boolean }
    | { readonly kind: "edit"; readonly calendar: CalendarSummary; readonly focus?: "reminders" };

interface CalendarForm {
    readonly name: string;
    readonly color: string;
    readonly description: string;
    readonly timezone: string;
    readonly components: "VEVENT" | "VTODO" | "VEVENT,VTODO";
    readonly transparent: boolean;
    readonly alarmsMuted: boolean;
    readonly defaultAlarms: DefaultAlarms;
}

function formOf(target: CalendarDialogTarget, used: readonly string[]): CalendarForm {
    if (target.kind === "new") {
        const color =
            CALENDAR_COLORS.find((candidate) => !used.includes(candidate)) ?? CALENDAR_COLORS[0];
        return {
            name: "",
            color,
            description: "",
            timezone: "",
            components: target.withTasks ? "VEVENT,VTODO" : "VEVENT",
            transparent: false,
            alarmsMuted: false,
            defaultAlarms: { timed: [], allDay: [] }
        };
    }
    const calendar = target.calendar;
    return {
        name: calendar.name,
        color: calendar.ownColor,
        description: calendar.description,
        timezone: calendar.timezone,
        components:
            calendar.components.includes("VEVENT") && calendar.components.includes("VTODO")
                ? "VEVENT,VTODO"
                : calendar.components.includes("VTODO")
                  ? "VTODO"
                  : "VEVENT",
        transparent: calendar.transparent,
        alarmsMuted: calendar.alarmsMuted,
        defaultAlarms: calendar.defaultAlarms
    };
}

/** Whether this reader changes the calendar itself, or only how they see it. */
export function ownsSettings(calendar: CalendarSummary): boolean {
    return calendar.reach === "owner" || calendar.reach === "manage";
}

export function DefaultReminders({
    value,
    onChange,
    allDay
}: {
    value: readonly number[];
    onChange: (minutes: number[]) => void;
    allDay: boolean;
}) {
    const t = useCalendarT();
    const { words, locale } = useRuleT();
    const describe = (minutes: number) =>
        engine.describeTrigger({ kind: "relative", minutes, related: "START" }, allDay, words, {
            locale
        });
    const presets = engine
        .defaultAlarmPresets(allDay)
        .flatMap((trigger) => (trigger.kind === "relative" ? [trigger.minutes] : []));
    return (
        <div className="flex flex-col gap-1.5">
            <ul className="flex flex-wrap gap-1">
                {value.map((minutes) => (
                    <li key={minutes}>
                        <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-xs tabular-nums">
                            {describe(minutes)}
                            <button
                                type="button"
                                aria-label={t("reminderEditor.remove", {
                                    reminder: describe(minutes)
                                })}
                                title={t("reminderEditor.remove", { reminder: describe(minutes) })}
                                onClick={() => onChange(value.filter((entry) => entry !== minutes))}
                                className="text-muted-foreground hover:text-foreground"
                            >
                                <X className="size-3.5" />
                            </button>
                        </span>
                    </li>
                ))}
            </ul>
            {value.length < 5 ? (
                <Select
                    className="w-56"
                    aria-label={t("reminderEditor.add")}
                    placeholder={t("reminderEditor.add")}
                    value=""
                    onValueChange={(minutes) =>
                        onChange([...value, Number(minutes)].sort((a, b) => a - b))
                    }
                    options={presets
                        .filter((minutes) => !value.includes(minutes))
                        .map((minutes) => ({ value: String(minutes), label: describe(minutes) }))}
                />
            ) : null}
        </div>
    );
}

export function CalendarDialog({
    target,
    calendars,
    onClose,
    onSaved
}: {
    target: CalendarDialogTarget | null;
    calendars: readonly CalendarSummary[];
    onClose: () => void;
    onSaved: (calendar: CalendarSummary) => void;
}) {
    const t = useCalendarT();
    const toast = useToast();
    const ids = useId();
    const used = useMemo(() => calendars.map((calendar) => calendar.ownColor), [calendars]);
    const [form, setForm] = useState<CalendarForm | null>(null);
    const [initial, setInitial] = useState<CalendarForm | null>(null);
    const [displayColor, setDisplayColor] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    useEffect(() => {
        setProblem(null);
        if (!target) return;
        const next = formOf(target, used);
        setForm(next);
        setInitial(next);
        setDisplayColor(target.kind === "edit" ? target.calendar.color : null);
        // A new target is a new form; the colours in use only pick the first one.
    }, [target]);

    if (!target || !form || !initial) return null;
    const calendar = target.kind === "edit" ? target.calendar : null;
    const owner = calendar === null || ownsSettings(calendar);
    const set = (change: Partial<CalendarForm>) => setForm({ ...form, ...change });

    const createInput = {
        name: form.name,
        color: form.color,
        description: form.description,
        timezone: form.timezone,
        components: form.components
    };
    const patch = calendar
        ? Object.fromEntries(
              (
                  [
                      "name",
                      "color",
                      "description",
                      "timezone",
                      "transparent",
                      "alarmsMuted",
                      "defaultAlarms"
                  ] as const
              )
                  .filter((key) => JSON.stringify(form[key]) !== JSON.stringify(initial[key]))
                  .map((key) => [key, form[key]])
          )
        : null;
    const parsed = calendar
        ? calendarPatchSchema.safeParse(patch)
        : calendarInputSchema.safeParse(createInput);
    const nameEmpty = form.name.trim() === "";
    const colorChanged = calendar !== null && !owner && displayColor !== calendar.color;
    const dirty = calendar ? (owner ? Object.keys(patch ?? {}).length > 0 : colorChanged) : true;
    const blocked = !dirty
        ? t("editor.noChanges")
        : owner && nameEmpty
          ? t("editor.incomplete")
          : owner && !parsed.success
            ? t("editor.fixErrors")
            : null;

    const save = async () => {
        if (blocked || busy) return;
        setBusy(true);
        setProblem(null);
        try {
            if (!calendar) {
                const answer = await unwrap(
                    () => calendarActions.createCalendarAction(createInput),
                    t("screen.failed")
                );
                toast.show({
                    key: "calendar-created",
                    title: t("calendarDialog.created", { name: answer.calendar.name })
                });
                onSaved(answer.calendar);
            } else if (owner) {
                const answer = await unwrap(
                    () => calendarActions.updateCalendarAction(calendar.id, patch),
                    t("screen.failed")
                );
                onSaved(answer.calendar);
            } else {
                await unwrap(
                    () => calendarActions.setDisplayAction(calendar.id, { color: displayColor }),
                    t("screen.failed")
                );
                onSaved({ ...calendar, color: displayColor ?? calendar.ownColor });
            }
            onClose();
        } catch (caught) {
            setProblem(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const title = !calendar
        ? form.components.includes("VTODO")
            ? t("calendarDialog.newWithTasks")
            : t("calendarDialog.new")
        : t("calendarDialog.edit");
    const colorValue = owner ? form.color : (displayColor ?? calendar?.color ?? form.color);
    const setColor = (color: string) => (owner ? set({ color }) : setDisplayColor(color));

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader className="pr-8">
                    <DialogTitle>{title}</DialogTitle>
                    {calendar && !owner ? (
                        <DialogDescription>
                            {t("calendarDialog.sharedHint", { owner: calendar.owner?.name ?? "" })}
                        </DialogDescription>
                    ) : null}
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <FieldRow
                        label={t("calendarDialog.name")}
                        htmlFor={`${ids}-name`}
                        error={
                            owner &&
                            !nameEmpty &&
                            !parsed.success &&
                            parsed.error.issues.some((issue) => issue.path[0] === "name")
                                ? t("calendarDialog.nameInvalid")
                                : null
                        }
                    >
                        <Input
                            id={`${ids}-name`}
                            required
                            aria-required
                            value={form.name}
                            maxLength={120}
                            disabled={!owner}
                            onChange={(event) => set({ name: event.target.value })}
                            autoFocus={target.kind === "new"}
                        />
                    </FieldRow>
                    <FieldRow
                        label={owner ? t("calendarDialog.color") : t("calendarDialog.yourColor")}
                    >
                        <div
                            className="flex flex-wrap items-center gap-1.5"
                            role="radiogroup"
                            aria-label={t("calendarDialog.color")}
                        >
                            {CALENDAR_COLORS.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    role="radio"
                                    aria-checked={colorValue === color}
                                    aria-label={color}
                                    title={color}
                                    onClick={() => setColor(color)}
                                    className={cn(
                                        "size-6 rounded-full border-2",
                                        colorValue === color
                                            ? "border-foreground"
                                            : "border-transparent"
                                    )}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                            <ColorPicker
                                value={colorValue}
                                onChange={(color) => setColor(color.toLowerCase())}
                                label={t("calendarDialog.customColor")}
                            />
                        </div>
                    </FieldRow>
                    {owner ? (
                        <>
                            <FieldRow
                                label={t("calendarDialog.description")}
                                htmlFor={`${ids}-description`}
                            >
                                <Textarea
                                    id={`${ids}-description`}
                                    rows={2}
                                    maxLength={2000}
                                    value={form.description}
                                    onChange={(event) => set({ description: event.target.value })}
                                />
                            </FieldRow>
                            <FieldRow
                                label={t("calendarDialog.timezone")}
                                hint={t("calendarDialog.timezoneHint")}
                            >
                                <ZonePicker
                                    value={form.timezone}
                                    onChange={(timezone) => set({ timezone })}
                                    allowFloating
                                    label={t("calendarDialog.timezone")}
                                />
                            </FieldRow>
                            {!calendar ? (
                                <FieldRow label={t("calendarDialog.holds")}>
                                    <Select
                                        aria-label={t("calendarDialog.holds")}
                                        value={form.components}
                                        onValueChange={(components) =>
                                            set({
                                                components: components as CalendarForm["components"]
                                            })
                                        }
                                        options={(["VEVENT", "VEVENT,VTODO", "VTODO"] as const).map(
                                            (value) => ({
                                                value,
                                                label: t(
                                                    `calendarDialog.components.${value === "VEVENT,VTODO" ? "both" : value}`
                                                )
                                            })
                                        )}
                                    />
                                </FieldRow>
                            ) : null}
                            {calendar ? (
                                <section className="flex flex-col gap-2" id={`${ids}-reminders`}>
                                    <GroupHeading>
                                        {t("calendarDialog.defaultReminders")}
                                    </GroupHeading>
                                    <FieldRow label={t("calendarDialog.timedReminders")}>
                                        <DefaultReminders
                                            allDay={false}
                                            value={form.defaultAlarms.timed}
                                            onChange={(timed) =>
                                                set({
                                                    defaultAlarms: { ...form.defaultAlarms, timed }
                                                })
                                            }
                                        />
                                    </FieldRow>
                                    <FieldRow label={t("calendarDialog.allDayReminders")}>
                                        <DefaultReminders
                                            allDay
                                            value={form.defaultAlarms.allDay}
                                            onChange={(allDay) =>
                                                set({
                                                    defaultAlarms: { ...form.defaultAlarms, allDay }
                                                })
                                            }
                                        />
                                    </FieldRow>
                                    <label className="flex items-center justify-between gap-3 text-[0.8125rem]">
                                        <span>{t("calendarDialog.mute")}</span>
                                        <Switch
                                            checked={form.alarmsMuted}
                                            onChange={(alarmsMuted) => set({ alarmsMuted })}
                                            aria-label={t("calendarDialog.mute")}
                                        />
                                    </label>
                                    <label className="flex items-center justify-between gap-3 text-[0.8125rem]">
                                        <span>{t("calendarDialog.neverBusy")}</span>
                                        <Switch
                                            checked={form.transparent}
                                            onChange={(transparent) => set({ transparent })}
                                            aria-label={t("calendarDialog.neverBusy")}
                                        />
                                    </label>
                                </section>
                            ) : null}
                        </>
                    ) : null}
                    {problem ? (
                        <p role="alert" className="text-xs text-danger">
                            {problem}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                            {t("screen.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={blocked !== null || busy}
                            title={blocked ?? undefined}
                            className={cn(blocked !== null && "opacity-50")}
                        >
                            {busy
                                ? t("screen.saving")
                                : calendar
                                  ? t("screen.save")
                                  : t("calendarDialog.create")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
