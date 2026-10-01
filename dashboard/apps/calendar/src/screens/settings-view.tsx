"use client";

/**
 * The calendar's settings: how it is drawn, the zone it is read in, what new
 * events start with, working hours, the legend of how events are drawn, the
 * keyboard, and bringing calendars in and out.
 *
 * A switch or a choice is saved the moment it changes (and put back with a note
 * if the server refuses it); working hours, being a set of ranges that only
 * make sense together, are saved with their own button.
 */

import * as time from "./time";
import { ColorDot } from "./ui";
import * as engine from "../engine";
import { useCalendarT } from "./i18n";
import Link from "next/link";
import { Plus, X } from "lucide-react";
import { ZonePicker } from "./zone-picker";
import { ImportExport } from "./import-export";
import { hostUi } from "@polaris/app-host/client";
import type { CalendarSummary } from "../lib/wire";
import { ShortcutsTable } from "./shortcuts-dialog";
import { DefaultReminders } from "./calendar-dialog";
import * as calendarActions from "../actions/calendars";
import * as preferenceActions from "../actions/preferences";
import { cacheKey, unwrap, useCachedRead } from "./cached-read";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle, cn, Input, Select, Skeleton, Switch, useToast } from "@polaris/ui";
import { SLOT_MINUTES, VIEWS, preferencesPatchSchema, type CalendarPreferences } from "../lib/preferences";

type WorkingHours = CalendarPreferences["workingHours"];
const DAYS = ["1", "2", "3", "4", "5", "6", "0"] as const;
const AUTO = "auto";
const NONE = "none";

function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
                <label htmlFor={htmlFor} className="text-[0.8125rem] text-foreground">
                    {label}
                </label>
                {hint ? <p className="text-xs text-foreground-subtle">{hint}</p> : null}
            </div>
            <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 sm:justify-end">{children}</div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    <span role="heading" aria-level={2}>
                        {title}
                    </span>
                </CardTitle>
            </CardHeader>
            <CardBody>{children}</CardBody>
        </Card>
    );
}

export function SettingsView() {
    const t = useCalendarT();
    const toast = useToast();
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const ids = useId();
    const preferencesRead = useCachedRead<CalendarPreferences>(cacheKey("preferences"), async () => (await unwrap(() => preferenceActions.loadPreferencesAction(), t("screen.failed"))).preferences);
    const calendarsRead = useCachedRead<CalendarSummary[]>(cacheKey("calendars"), async () => (await unwrap(() => calendarActions.listCalendarsAction(), t("screen.failed"))).calendars);
    const preferences = preferencesRead.data;

    const save = async (patch: Partial<CalendarPreferences>) => {
        const current = preferencesRead.data;
        if (!current) return;
        const changed = (Object.keys(patch) as (keyof CalendarPreferences)[]).some((key) => JSON.stringify(patch[key]) !== JSON.stringify(current[key]));
        if (!changed || !preferencesPatchSchema.safeParse(patch).success) return;
        preferencesRead.replace({ ...current, ...patch });
        try {
            const answer = await unwrap(() => preferenceActions.savePreferencesAction(patch), t("screen.failed"));
            preferencesRead.replace(answer.preferences);
        } catch (caught) {
            preferencesRead.replace(current);
            toast.show({ key: "calendar-settings-failed", title: t("settingsPage.saveFailed"), body: caught instanceof Error ? caught.message : undefined });
        }
    };

    if (preferencesRead.error && !preferences) {
        return (
            <div role="alert" className="flex flex-col items-start gap-2">
                <p className="text-[0.8125rem]">{t("settingsPage.loadFailed")}</p>
                <Button size="sm" variant="outline" onClick={preferencesRead.refresh}>
                    {t("screen.retry")}
                </Button>
            </div>
        );
    }
    if (!preferences) {
        return (
            <div className="flex flex-col gap-4" aria-hidden>
                {[0, 1, 2].map((index) => (
                    <Card key={index}>
                        <CardBody className="flex flex-col gap-3">
                            <Skeleton className="h-4 w-40" />
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-8 w-full" />
                        </CardBody>
                    </Card>
                ))}
            </div>
        );
    }

    const firstDayOptions = [{ value: AUTO, label: t("settingsPage.firstDayAuto", { day: time.weekdayLabels(locale, format.weekStartsOn, "long")[0] ?? "" }) }, ...time.weekdayLabels(locale, 0, "long").map((label, index) => ({ value: String(index), label }))];
    const writable = (calendarsRead.data ?? []).filter((calendar) => calendar.writable && calendar.components.includes("VEVENT"));
    const calendarChoice = (value: string | null) => (value && writable.some((calendar) => calendar.id === value) ? value : AUTO);
    const calendarOptions = [{ value: AUTO, label: t("settingsPage.firstOwn") }, ...writable.map((calendar) => ({ value: calendar.id, label: calendar.name, icon: <ColorDot color={calendar.color} /> }))];
    const toggle = (key: "showWeekends" | "showWeekNumbers" | "dimPast" | "showDeclined" | "showTasks" | "skipPopover" | "keyboardShortcuts" | "speedyMeetings") => (
        <Switch checked={preferences[key]} onChange={(value) => void save({ [key]: value } as Partial<CalendarPreferences>)} aria-label={t(`settingsPage.${key}`)} />
    );

    return (
        <div className="flex flex-col gap-4">
            <Section title={t("settingsPage.display")}>
                <Row label={t("settingsPage.defaultView")} hint={t("settingsPage.defaultViewHint")}>
                    <Select className="w-40" aria-label={t("settingsPage.defaultView")} value={preferences.view} onValueChange={(view) => void save({ view: view as CalendarPreferences["view"] })} options={VIEWS.map((view) => ({ value: view, label: t(`views.${view}`, { count: preferences.customDays }) }))} />
                </Row>
                <Row label={t("settingsPage.customDays")}>
                    <Select className="w-28" aria-label={t("settingsPage.customDays")} value={String(preferences.customDays)} onValueChange={(days) => void save({ customDays: Number(days) })} options={[2, 3, 4, 5, 6, 7].map((days) => ({ value: String(days), label: t("views.days", { count: days }) }))} />
                </Row>
                <Row label={t("settingsPage.firstDay")}>
                    <Select className="w-44" aria-label={t("settingsPage.firstDay")} value={preferences.firstDay === null ? AUTO : String(preferences.firstDay)} onValueChange={(day) => void save({ firstDay: day === AUTO ? null : Number(day) })} options={firstDayOptions} />
                </Row>
                <Row label={t("settingsPage.showWeekends")}>{toggle("showWeekends")}</Row>
                <Row label={t("settingsPage.showWeekNumbers")}>{toggle("showWeekNumbers")}</Row>
                <Row label={t("settingsPage.slotMinutes")} hint={t("settingsPage.slotMinutesHint")}>
                    <Select className="w-32" aria-label={t("settingsPage.slotMinutes")} value={String(preferences.slotMinutes)} onValueChange={(minutes) => void save({ slotMinutes: Number(minutes) })} options={SLOT_MINUTES.map((minutes) => ({ value: String(minutes), label: t("editor.minutes", { count: minutes }) }))} />
                </Row>
                <Row label={t("settingsPage.dayStart")} htmlFor={`${ids}-day-start`}>
                    <Input id={`${ids}-day-start`} type="time" className="w-28 tabular-nums" defaultValue={preferences.dayStart} onBlur={(event) => /^([01]\d|2[0-3]):[0-5]\d$/.test(event.target.value) && void save({ dayStart: event.target.value })} />
                </Row>
                <Row label={t("settingsPage.eventLimit")} hint={t("settingsPage.eventLimitHint")}>
                    <Select className="w-28" aria-label={t("settingsPage.eventLimit")} value={String(preferences.eventLimit)} onValueChange={(limit) => void save({ eventLimit: Number(limit) })} options={[0, 2, 3, 4, 5, 6, 8, 10].map((limit) => ({ value: String(limit), label: limit === 0 ? t("settingsPage.all") : String(limit) }))} />
                </Row>
                <Row label={t("settingsPage.dimPast")}>{toggle("dimPast")}</Row>
                <Row label={t("settingsPage.showDeclined")}>{toggle("showDeclined")}</Row>
                <Row label={t("settingsPage.showTasks")} hint={t("settingsPage.showTasksHint")}>
                    {toggle("showTasks")}
                </Row>
                <Row label={t("settingsPage.skipPopover")} hint={t("settingsPage.skipPopoverHint")}>
                    {toggle("skipPopover")}
                </Row>
            </Section>

            <Section title={t("settingsPage.zones")}>
                <Row label={t("settingsPage.timezone")} hint={preferences.timezone === AUTO ? t("settingsPage.timezoneAuto", { zone: time.displayZone(AUTO, format.preferences.timeZone) }) : undefined}>
                    <Select className="w-36" aria-label={t("settingsPage.timezoneMode")} value={preferences.timezone === AUTO ? AUTO : "chosen"} onValueChange={(mode) => void save({ timezone: mode === AUTO ? AUTO : time.browserZone() })} options={[{ value: AUTO, label: t("settingsPage.automatic") }, { value: "chosen", label: t("settingsPage.chosen") }]} />
                    {preferences.timezone !== AUTO ? (
                        <div className="w-full sm:w-72">
                            <ZonePicker value={preferences.timezone} onChange={(zone) => zone && void save({ timezone: zone })} label={t("settingsPage.timezone")} />
                        </div>
                    ) : null}
                </Row>
                <Row label={t("settingsPage.secondary")} hint={t("settingsPage.secondaryHint")}>
                    <Select className="w-36" aria-label={t("settingsPage.secondaryMode")} value={preferences.secondaryTimezone ? "chosen" : NONE} onValueChange={(mode) => void save({ secondaryTimezone: mode === NONE ? null : "UTC" })} options={[{ value: NONE, label: t("settingsPage.none") }, { value: "chosen", label: t("settingsPage.chosen") }]} />
                    {preferences.secondaryTimezone ? (
                        <div className="w-full sm:w-72">
                            <ZonePicker value={preferences.secondaryTimezone} onChange={(zone) => zone && void save({ secondaryTimezone: zone })} label={t("settingsPage.secondary")} />
                        </div>
                    ) : null}
                </Row>
                <WorldClockSettings zones={preferences.worldClock} onChange={(worldClock) => void save({ worldClock })} />
            </Section>

            <Section title={t("settingsPage.newEvents")}>
                <Row label={t("settingsPage.defaultDuration")}>
                    <Select className="w-32" aria-label={t("settingsPage.defaultDuration")} value={String(preferences.defaultDuration)} onValueChange={(minutes) => void save({ defaultDuration: Number(minutes) })} options={[15, 30, 45, 60, 90, 120].map((minutes) => ({ value: String(minutes), label: t("editor.minutes", { count: minutes }) }))} />
                </Row>
                <Row label={t("settingsPage.speedyMeetings")} hint={t("settingsPage.speedyMeetingsHint")}>
                    {toggle("speedyMeetings")}
                </Row>
                <Row label={t("settingsPage.timedReminders")}>
                    <DefaultReminders allDay={false} value={preferences.defaultAlarms.timed} onChange={(timed) => void save({ defaultAlarms: { ...preferences.defaultAlarms, timed } })} />
                </Row>
                <Row label={t("settingsPage.allDayReminders")}>
                    <DefaultReminders allDay value={preferences.defaultAlarms.allDay} onChange={(allDay) => void save({ defaultAlarms: { ...preferences.defaultAlarms, allDay } })} />
                </Row>
                <Row label={t("settingsPage.defaultCalendar")}>
                    <Select className="w-52" aria-label={t("settingsPage.defaultCalendar")} value={calendarChoice(preferences.defaultCalendarId)} onValueChange={(id) => void save({ defaultCalendarId: id === AUTO ? null : id })} options={calendarOptions} />
                </Row>
                <Row label={t("settingsPage.invitationCalendar")} hint={t("settingsPage.invitationCalendarHint")}>
                    <Select className="w-52" aria-label={t("settingsPage.invitationCalendar")} value={calendarChoice(preferences.invitationCalendarId)} onValueChange={(id) => void save({ invitationCalendarId: id === AUTO ? null : id })} options={calendarOptions} />
                </Row>
            </Section>

            <Section title={t("settingsPage.workingHours")}>
                <WorkingHoursEditor value={preferences.workingHours} locale={locale} onSave={(workingHours) => save({ workingHours })} />
            </Section>

            <Section title={t("settingsPage.legend")}>
                <Legend />
            </Section>

            <Section title={t("settingsPage.shortcuts")}>
                <Row label={t("settingsPage.keyboardShortcuts")}>{toggle("keyboardShortcuts")}</Row>
                <div className="pt-3">
                    <ShortcutsTable enabled={preferences.keyboardShortcuts} />
                </div>
            </Section>

            <Section title={t("settingsPage.transfer")}>
                <ImportExport calendars={calendarsRead.data} zone={time.displayZone(preferences.timezone, format.preferences.timeZone)} onImported={calendarsRead.refresh} />
            </Section>

            <Section title={t("settingsPage.everybody")}>
                <Row label={t("settingsPage.everybodyLabel")} hint={t("settingsPage.everybodyHint")}>
                    <Button asChild size="sm" variant="outline">
                        <Link href="/calendar/admin">{t("settingsPage.everybodyOpen")}</Link>
                    </Button>
                </Row>
            </Section>
        </div>
    );
}

function WorldClockSettings({ zones, onChange }: { zones: readonly string[]; onChange: (zones: string[]) => void }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const [adding, setAdding] = useState(false);
    const now = new Date();
    return (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-[0.8125rem]">{t("settingsPage.worldClock")}</p>
            {zones.length === 0 ? <p className="text-xs text-foreground-subtle">{t("settingsPage.worldClockNone")}</p> : null}
            <ul className="flex flex-col gap-1">
                {zones.map((zone) => (
                    <li key={zone} className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[0.8125rem] tabular-nums" title={zone}>
                            {engine.zoneLabel(zone, now, locale)}
                        </span>
                        <Button size="icon-sm" variant="ghost" aria-label={t("settingsPage.removeClock", { zone })} title={t("settingsPage.removeClock", { zone })} onClick={() => onChange(zones.filter((entry) => entry !== zone))}>
                            <X />
                        </Button>
                    </li>
                ))}
            </ul>
            {adding ? (
                <div className="w-full sm:w-72">
                    <ZonePicker
                        value=""
                        label={t("settingsPage.addClock")}
                        onChange={(zone) => {
                            if (zone && !zones.includes(zone)) onChange([...zones, zone]);
                            setAdding(false);
                        }}
                    />
                </div>
            ) : zones.length < 8 ? (
                <Button size="sm" variant="outline" className="self-start" onClick={() => setAdding(true)}>
                    <Plus />
                    {t("settingsPage.addClock")}
                </Button>
            ) : null}
        </div>
    );
}

function WorkingHoursEditor({ value, locale, onSave }: { value: WorkingHours; locale: string; onSave: (hours: WorkingHours) => Promise<void> }) {
    const t = useCalendarT();
    const [draft, setDraft] = useState<WorkingHours>(value);
    const [busy, setBusy] = useState(false);
    useEffect(() => setDraft(value), [value]);
    const names = time.weekdayLabels(locale, 0, "long");
    const cleaned = Object.fromEntries(Object.entries(draft).filter(([, spans]) => (spans ?? []).length > 0)) as WorkingHours;
    const check = preferencesPatchSchema.safeParse({ workingHours: cleaned });
    const dirty = JSON.stringify(cleaned) !== JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, spans]) => (spans ?? []).length > 0)));
    const blocked = !dirty ? t("editor.noChanges") : !check.success ? t("settingsPage.hoursInvalid") : null;
    const setDay = (day: string, spans: { from: string; to: string }[]) => setDraft({ ...draft, [day]: spans });

    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs text-foreground-subtle">{t("settingsPage.workingHoursHint")}</p>
            {DAYS.map((day) => {
                const spans = draft[day] ?? [];
                return (
                    <div key={day} className="flex flex-col gap-2 border-t border-border py-2 sm:flex-row sm:items-start">
                        <label className="flex w-40 shrink-0 items-center gap-2 text-[0.8125rem]">
                            <Switch checked={spans.length > 0} onChange={(on) => setDay(day, on ? [{ from: "09:00", to: "17:00" }] : [])} aria-label={t("settingsPage.worksOn", { day: names[Number(day)] ?? day })} />
                            {names[Number(day)]}
                        </label>
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            {spans.length === 0 ? <span className="text-xs text-foreground-subtle">{t("settingsPage.dayOff")}</span> : null}
                            {spans.map((span, index) => {
                                const bad = span.from >= span.to;
                                return (
                                    <div key={index} className="flex flex-wrap items-center gap-2">
                                        <Input type="time" aria-label={t("settingsPage.from")} className={cn("w-28 tabular-nums", bad && "border-danger")} value={span.from} onChange={(event) => setDay(day, spans.map((entry, at) => (at === index ? { ...entry, from: event.target.value } : entry)))} />
                                        <span className="text-xs text-foreground-subtle">-</span>
                                        <Input type="time" aria-label={t("settingsPage.to")} className={cn("w-28 tabular-nums", bad && "border-danger")} value={span.to} onChange={(event) => setDay(day, spans.map((entry, at) => (at === index ? { ...entry, to: event.target.value } : entry)))} />
                                        <Button size="icon-sm" variant="ghost" aria-label={t("settingsPage.removeRange")} title={t("settingsPage.removeRange")} onClick={() => setDay(day, spans.filter((_, at) => at !== index))}>
                                            <X />
                                        </Button>
                                        {bad ? <span className="text-xs text-danger">{t("settingsPage.endAfterStart")}</span> : null}
                                    </div>
                                );
                            })}
                            {spans.length > 0 && spans.length < 6 ? (
                                <Button size="xs" variant="ghost" className="self-start" onClick={() => setDay(day, [...spans, { from: spans[spans.length - 1]?.to ?? "13:00", to: "18:00" }])}>
                                    <Plus />
                                    {t("settingsPage.addRange")}
                                </Button>
                            ) : null}
                        </div>
                    </div>
                );
            })}
            <div className="flex justify-end gap-2 pt-2">
                <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={() => setDraft(value)}>
                    {t("screen.reset")}
                </Button>
                <Button
                    size="sm"
                    aria-disabled={blocked !== null || busy}
                    title={blocked ?? undefined}
                    className={cn(blocked !== null && "opacity-50")}
                    onClick={async () => {
                        if (blocked || busy) return;
                        setBusy(true);
                        await onSave(cleaned);
                        setBusy(false);
                    }}
                >
                    {busy ? t("screen.saving") : t("screen.save")}
                </Button>
            </div>
        </div>
    );
}

/** How the grid draws each kind of event, drawn the same way. */
function Legend() {
    const t = useCalendarT();
    const sample = "#1f77b4";
    const rows: { key: "confirmed" | "needsAction" | "tentative" | "declined" | "cancelled" | "free" | "busyOnly" | "past" | "task"; style: CSSProperties; strike?: boolean }[] = [
        { key: "confirmed", style: { backgroundColor: sample, color: "#fff" } },
        { key: "needsAction", style: { border: `1px dashed ${sample}` } },
        { key: "tentative", style: { backgroundColor: sample, color: "#fff", backgroundImage: "repeating-linear-gradient(135deg, transparent 0 5px, rgb(255 255 255 / 0.22) 5px 10px)" } },
        { key: "declined", style: { backgroundColor: sample, color: "#fff", opacity: 0.6 }, strike: true },
        { key: "cancelled", style: { backgroundColor: sample, color: "#fff" }, strike: true },
        { key: "free", style: { border: `1px solid ${sample}` } },
        { key: "busyOnly", style: { backgroundColor: sample, color: "#fff", backgroundImage: "repeating-linear-gradient(45deg, transparent 0 4px, rgb(0 0 0 / 0.18) 4px 8px)" } },
        { key: "past", style: { backgroundColor: sample, color: "#fff", opacity: 0.55 } },
        { key: "task", style: { border: `1px solid ${sample}`, borderLeftWidth: 3 } }
    ];
    return (
        <ul className="grid gap-2 sm:grid-cols-2">
            {rows.map((row) => (
                <li key={row.key} className="flex min-w-0 items-center gap-3">
                    <span className={cn("inline-flex h-6 w-24 shrink-0 items-center truncate rounded px-2 text-xs", row.strike && "line-through")} style={row.style}>
                        {t("legend.sample")}
                    </span>
                    <span className="min-w-0 text-[0.8125rem] text-muted-foreground">{t(`legend.${row.key}`)}</span>
                </li>
            ))}
        </ul>
    );
}

