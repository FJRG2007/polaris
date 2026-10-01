"use client";

/**
 * An event's reminders: Nextcloud's presets for timed and all-day events, a
 * custom time before or after the start or the end, or a fixed date and time;
 * shown as a notification or sent by email. Each is described by the engine in
 * the reader's words, which is also how the view mode lists them.
 */

import { wallOf } from "./time";
import { useState } from "react";
import * as engine from "../engine";
import { useCalendarT, useRuleT } from "./i18n";
import type { AlarmDraft } from "./editor-model";
import { Button, Input, Select } from "@polaris/ui";
import { Bell, Mail, Plus, Volume2, X } from "lucide-react";

/** Google's limit, and plenty. */
export const MOST_REMINDERS = 5;

const UNITS = { minutes: 1, hours: 60, days: 1440, weeks: 10_080 } as const;
type Unit = keyof typeof UNITS;

function sameTrigger(a: engine.AlarmTrigger, b: engine.AlarmTrigger): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function describeAlarm(alarm: AlarmDraft, allDay: boolean, words: engine.RuleTranslator, locale: string, zone: string): string {
    return engine.describeTrigger(alarm.trigger, allDay, words, { locale, timeZone: zone });
}

export function RemindersEditor({ value, onChange, allDay, zone, disabled }: { value: readonly AlarmDraft[]; onChange: (alarms: AlarmDraft[]) => void; allDay: boolean; zone: string; disabled?: boolean }) {
    const t = useCalendarT();
    const { words, locale } = useRuleT();
    const [custom, setCustom] = useState<null | { mode: "relative"; amount: number; unit: Unit; direction: "before" | "after"; related: "START" | "END" } | { mode: "absolute"; at: string }>(null);

    const presets = engine.defaultAlarmPresets(allDay);
    const add = (trigger: engine.AlarmTrigger) => {
        if (value.length >= MOST_REMINDERS || value.some((alarm) => sameTrigger(alarm.trigger, trigger))) return;
        onChange([...value, { action: "DISPLAY", trigger, description: "" }]);
    };
    const update = (index: number, change: Partial<AlarmDraft>) => onChange(value.map((alarm, at) => (at === index ? { ...alarm, ...change } : alarm)));
    const remove = (index: number) => onChange(value.filter((_, at) => at !== index));

    const addCustom = () => {
        if (!custom) return;
        if (custom.mode === "absolute") {
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(custom.at)) return;
            add({ kind: "absolute", at: engine.wallToInstant(engine.parseWall(custom.at), zone).toISOString() });
        } else {
            const minutes = Math.max(0, Math.floor(custom.amount)) * UNITS[custom.unit];
            add({ kind: "relative", minutes: custom.direction === "before" ? -minutes : minutes, related: custom.related });
        }
        setCustom(null);
    };

    const actionOptions = (current: engine.AlarmAction) => [
        { value: "DISPLAY", label: t("reminderEditor.action.DISPLAY"), icon: <Bell className="size-4" /> },
        { value: "EMAIL", label: t("reminderEditor.action.EMAIL"), icon: <Mail className="size-4" /> },
        // Sound is kept when a file brought one; it is not offered for a new one.
        ...(current === "AUDIO" ? [{ value: "AUDIO", label: t("reminderEditor.action.AUDIO"), icon: <Volume2 className="size-4" /> }] : [])
    ];

    return (
        <div className="flex flex-col gap-2">
            {value.length === 0 ? <p className="text-xs text-muted-foreground">{t("reminderEditor.none")}</p> : null}
            <ul className="flex flex-col gap-1.5">
                {value.map((alarm, index) => {
                    const described = describeAlarm(alarm, allDay, words, locale, zone);
                    return (
                        <li key={`${index}-${JSON.stringify(alarm.trigger)}`} className="flex min-w-0 items-center gap-2">
                            <Select className="w-36 shrink-0" aria-label={t("reminderEditor.how")} disabled={disabled} value={alarm.action} onValueChange={(action) => update(index, { action: action as engine.AlarmAction })} options={actionOptions(alarm.action)} />
                            <span className="min-w-0 flex-1 truncate text-[0.8125rem] tabular-nums" title={described}>
                                {described}
                            </span>
                            {!disabled ? (
                                <Button size="icon-sm" variant="ghost" aria-label={t("reminderEditor.remove", { reminder: described })} title={t("reminderEditor.remove", { reminder: described })} onClick={() => remove(index)}>
                                    <X />
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>

            {!disabled && value.length < MOST_REMINDERS ? (
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        className="w-56"
                        aria-label={t("reminderEditor.add")}
                        placeholder={t("reminderEditor.add")}
                        value=""
                        onValueChange={(choice) => {
                            if (choice === "custom") setCustom({ mode: "relative", amount: 15, unit: "minutes", direction: "before", related: "START" });
                            else if (choice === "absolute") setCustom({ mode: "absolute", at: "" });
                            else {
                                const preset = presets[Number(choice)];
                                if (preset) add(preset);
                            }
                        }}
                        options={[
                            ...presets
                                .map((trigger, index) => ({ trigger, index }))
                                .filter(({ trigger }) => !value.some((alarm) => sameTrigger(alarm.trigger, trigger)))
                                .map(({ trigger, index }) => ({ value: String(index), label: engine.describeTrigger(trigger, allDay, words, { locale, timeZone: zone }) })),
                            { value: "custom", label: t("reminderEditor.custom") },
                            { value: "absolute", label: t("reminderEditor.onDate") }
                        ]}
                    />
                </div>
            ) : null}
            {!disabled && value.length >= MOST_REMINDERS ? <p className="text-xs text-foreground-subtle">{t("reminderEditor.most", { count: MOST_REMINDERS })}</p> : null}

            {custom ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                    {custom.mode === "relative" ? (
                        <>
                            <Input
                                type="number"
                                min={0}
                                max={9999}
                                inputMode="numeric"
                                aria-label={t("reminderEditor.amount")}
                                className="w-20 tabular-nums"
                                value={custom.amount}
                                onChange={(event) => setCustom({ ...custom, amount: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                            />
                            <Select className="w-28" aria-label={t("reminderEditor.unit")} value={custom.unit} onValueChange={(unit) => setCustom({ ...custom, unit: unit as Unit })} options={(Object.keys(UNITS) as Unit[]).map((unit) => ({ value: unit, label: t(`reminderEditor.units.${unit}`) }))} />
                            <Select
                                className="w-44"
                                aria-label={t("reminderEditor.relation")}
                                value={`${custom.direction}-${custom.related}`}
                                onValueChange={(choice) => {
                                    const [direction, related] = choice.split("-") as ["before" | "after", "START" | "END"];
                                    setCustom({ ...custom, direction, related });
                                }}
                                options={(["before-START", "after-START", "before-END", "after-END"] as const).map((choice) => ({ value: choice, label: t(`reminderEditor.relations.${choice}`) }))}
                            />
                        </>
                    ) : (
                        <Input
                            type="datetime-local"
                            aria-label={t("reminderEditor.onDate")}
                            className="w-56 tabular-nums"
                            value={custom.at}
                            max={wallOf(new Date(Date.now() + 5 * 365 * 86_400_000), zone).slice(0, 16)}
                            onChange={(event) => setCustom({ mode: "absolute", at: event.target.value })}
                        />
                    )}
                    <Button size="sm" onClick={addCustom}>
                        <Plus />
                        {t("reminderEditor.addThis")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCustom(null)}>
                        {t("screen.cancel")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
