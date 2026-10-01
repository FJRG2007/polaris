"use client";

/**
 * The full event editor: every property of one event, as a dialog (the whole
 * screen on a phone).
 *
 * It opens on what the event is and whether this reader may change it. Save is
 * enabled only once what would be sent differs from what was loaded, and the
 * reason it is not is on the button. A change to a repeating event asks which
 * occurrences it reaches. Closing with changes asks first.
 *
 * Ctrl/Cmd+Enter or Ctrl/Cmd+S saves, Ctrl/Cmd+Delete deletes and Ctrl/Cmd+D
 * makes a copy.
 */

import * as engine from "../engine";
import { unwrap } from "./cached-read";
import * as model from "./editor-model";
import { ZonePicker } from "./zone-picker";
import { useScopeChoice } from "./scope-dialog";
import { editorShortcutFor } from "./shortcuts";
import { useCalendarT, useRuleT } from "./i18n";
import { hostUi } from "@polaris/app-host/client";
import * as eventActions from "../actions/events";
import * as meetingActions from "../actions/meeting";
import { AttendeesEditor } from "./attendees-editor";
import { RecurrenceEditor } from "./recurrence-editor";
import { eventPath, formatInstant, wallOf } from "./time";
import type { CalendarPreferences } from "../lib/preferences";
import type { CalendarSummary, EventDetail } from "../lib/wire";
import { ColorDot, FieldRow, GroupHeading, Linkified } from "./ui";
import { describeAlarm, RemindersEditor } from "./reminders-editor";
import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, Copy, Download, ExternalLink, Globe, Link2, MapPin, Paperclip, RefreshCw, Trash2, Video } from "lucide-react";
import { Badge, Button, cn, Dialog, DialogContent, DialogTitle, Input, Select, Skeleton, Textarea, useToast } from "@polaris/ui";

export type EditorTarget =
    | { readonly kind: "open"; readonly objectId: string; readonly recurrenceKey: string | null }
    | { readonly kind: "new"; readonly form: model.EditorForm };

const NONE = "none";

export function EventEditor({
    target,
    onClose,
    calendars,
    zone,
    preferences,
    onChanged,
    onOpen
}: {
    target: EditorTarget | null;
    onClose: () => void;
    calendars: readonly CalendarSummary[];
    zone: string;
    preferences: CalendarPreferences;
    /** Something was saved, deleted or copied: the grid reads again. */
    onChanged: () => void;
    /** Open another event in its place (the copy just made). */
    onOpen: (objectId: string) => void;
}) {
    const t = useCalendarT();
    const toast = useToast();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [askScope, scopeElement] = useScopeChoice();
    const [detail, setDetail] = useState<EventDetail | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [initial, setInitial] = useState<model.EditorForm | null>(null);
    const [form, setForm] = useState<model.EditorForm | null>(null);
    const [busy, setBusy] = useState(false);
    const [turn, setTurn] = useState(0);

    const targetKey = target ? (target.kind === "open" ? `${target.objectId}|${target.recurrenceKey ?? ""}` : "new") : null;

    useEffect(() => {
        setDetail(null);
        setFailure(null);
        if (!target) {
            setForm(null);
            setInitial(null);
            return;
        }
        if (target.kind === "new") {
            setForm(target.form);
            setInitial(target.form);
            return;
        }
        setForm(null);
        setInitial(null);
        let live = true;
        unwrap(() => eventActions.openEventAction({ objectId: target.objectId, recurrenceKey: target.recurrenceKey, zone }), t("screen.failed"))
            .then((answer) => {
                if (!live) return;
                const loaded = model.formFromDetail(answer.detail);
                setDetail(answer.detail);
                setForm(loaded);
                setInitial(loaded);
            })
            .catch((caught: unknown) => live && setFailure(caught instanceof Error ? caught.message : String(caught)));
        return () => {
            live = false;
        };
        // The target's identity is its key; a new object each render is the same event.
    }, [targetKey, zone, turn]);

    const isNew = target?.kind === "new";
    const writable = isNew || (detail?.writable ?? false);
    const check = useMemo(() => (form ? model.checkForm(form) : null), [form]);
    const dirty = form !== null && initial !== null && (isNew || !model.sameForm(form, initial));
    const blocked = !dirty ? t("editor.noChanges") : check?.incomplete ? t("editor.incomplete") : check && !check.input ? t("editor.fixErrors") : null;

    const close = useCallback(async () => {
        if (busy) return;
        const changed = form !== null && initial !== null && !model.sameForm(form, initial);
        if (writable && changed && !(await confirm({ title: t("editor.discardTitle"), description: t("editor.discardBody"), confirmLabel: t("editor.discard"), danger: true }))) return;
        onClose();
    }, [busy, writable, form, initial, confirm, t, onClose]);

    const save = async () => {
        if (!form || !check?.input || blocked || busy || !writable) return;
        let scope: engine.EditScope = "all";
        const repeating = detail !== null && detail.recurrenceKey !== null && detail.series !== null && (detail.series.rule !== null || detail.series.rdates.length > 0);
        if (repeating && initial) {
            const answer = await askScope({ action: "save", allowThis: model.sameRule(form, initial) });
            if (!answer) return;
            scope = answer;
        }
        setBusy(true);
        try {
            await unwrap(
                () =>
                    eventActions.saveEventAction({
                        objectId: detail?.objectId ?? null,
                        recurrenceKey: detail?.recurrenceKey ?? null,
                        scope,
                        version: detail?.version ?? null,
                        zone,
                        event: model.inputOf(form)
                    }),
                t("screen.failed")
            );
            toast.show({ key: "calendar-saved", title: isNew ? t("editor.created") : t("editor.saved") });
            onChanged();
            onClose();
        } catch (caught) {
            toast.show({ key: "calendar-save-failed", title: t("editor.saveFailed"), body: caught instanceof Error ? caught.message : undefined });
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!detail || !writable || busy) return;
        let scope: engine.EditScope = "all";
        const repeating = detail.recurrenceKey !== null && detail.series !== null && (detail.series.rule !== null || detail.series.rdates.length > 0);
        if (repeating) {
            const answer = await askScope({ action: "delete" });
            if (!answer) return;
            scope = answer;
        } else if (!(await confirm({ title: t("editor.deleteTitle"), description: t("editor.deleteBody", { title: detail.event.summary || t("screen.untitled") }), confirmLabel: t("screen.delete"), danger: true }))) {
            return;
        }
        setBusy(true);
        try {
            await unwrap(() => eventActions.deleteEventAction({ objectId: detail.objectId, recurrenceKey: detail.recurrenceKey, scope, zone }), t("screen.failed"));
            toast.show({ key: "calendar-deleted", title: t("editor.deleted") });
            onChanged();
            onClose();
        } catch (caught) {
            toast.show({ key: "calendar-delete-failed", title: t("editor.deleteFailed"), body: caught instanceof Error ? caught.message : undefined });
        } finally {
            setBusy(false);
        }
    };

    const duplicate = async () => {
        if (!detail || busy || dirty) return;
        setBusy(true);
        try {
            const answer = await unwrap(() => eventActions.duplicateEventAction({ objectId: detail.objectId, zone }), t("screen.failed"));
            toast.show({ key: "calendar-duplicated", title: t("editor.duplicated") });
            onChanged();
            onOpen(answer.objectId);
        } catch (caught) {
            toast.show({ key: "calendar-duplicate-failed", title: t("editor.duplicateFailed"), body: caught instanceof Error ? caught.message : undefined });
        } finally {
            setBusy(false);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const shortcut = editorShortcutFor(event);
        if (!shortcut) return;
        event.preventDefault();
        if (shortcut === "save") void save();
        else if (shortcut === "delete") void remove();
        else void duplicate();
    };

    const title = isNew ? t("editor.newTitle") : writable ? t("editor.editTitle") : t("editor.viewTitle");

    return (
        <>
            <Dialog open={target !== null} onOpenChange={(open) => !open && void close()}>
                <DialogContent
                    onKeyDown={onKeyDown}
                    aria-describedby={undefined}
                    className="flex max-h-[92vh] w-full max-w-3xl flex-col gap-0 p-0 max-sm:inset-0 max-sm:h-[100dvh] max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
                >
                    <div className="flex items-center gap-2 border-b border-border px-5 py-3 pr-14">
                        <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
                        {detail?.pending ? (
                            <Badge variant="warning" title={t("editor.pendingHint")}>
                                {t("editor.pending")}
                            </Badge>
                        ) : null}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                        {failure ? (
                            <div role="alert" className="flex flex-col items-start gap-2 py-8">
                                <p className="text-[0.8125rem] text-foreground">{t("editor.loadFailed")}</p>
                                <p className="text-xs text-muted-foreground">{failure}</p>
                                <Button size="sm" variant="outline" onClick={() => setTurn((value) => value + 1)}>
                                    <RefreshCw />
                                    {t("screen.retry")}
                                </Button>
                            </div>
                        ) : !form ? (
                            <EditorSkeleton />
                        ) : writable ? (
                            <EditForm form={form} setForm={setForm} detail={detail} calendars={calendars} zone={zone} preferences={preferences} errors={check?.errors ?? {}} onChanged={onChanged} />
                        ) : detail ? (
                            <ViewMode detail={detail} form={form} calendars={calendars} zone={zone} onChanged={onChanged} />
                        ) : null}
                    </div>
                    {form ? (
                        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
                            {detail ? (
                                <div className="flex items-center gap-1">
                                    {writable ? (
                                        <Button size="icon-sm" variant="ghost" aria-label={t("editor.delete")} title={t("editor.delete")} disabled={busy} onClick={() => void remove()}>
                                            <Trash2 />
                                        </Button>
                                    ) : null}
                                    {writable ? (
                                        <Button size="icon-sm" variant="ghost" aria-label={t("editor.duplicate")} title={dirty ? t("editor.duplicateSaveFirst") : t("editor.duplicate")} aria-disabled={dirty || busy} onClick={() => void duplicate()}>
                                            <Copy />
                                        </Button>
                                    ) : null}
                                    <Button asChild size="icon-sm" variant="ghost">
                                        <a href={`/api/calendar/export/event/${detail.objectId}`} download aria-label={t("editor.export")} title={t("editor.export")}>
                                            <Download />
                                        </a>
                                    </Button>
                                    <CopyLink objectId={detail.objectId} label={t("editor.copyLink")} />
                                </div>
                            ) : null}
                            <div className="ml-auto flex items-center gap-2">
                                <Button variant="ghost" onClick={() => void close()} disabled={busy}>
                                    {writable ? t("screen.cancel") : t("screen.close")}
                                </Button>
                                {writable ? (
                                    <Button aria-disabled={blocked !== null || busy} title={blocked ?? undefined} className={cn(blocked !== null && "opacity-50")} onClick={() => void save()}>
                                        {busy ? t("screen.saving") : t("screen.save")}
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                </DialogContent>
            </Dialog>
            {confirmElement}
            {scopeElement}
        </>
    );
}

function CopyLink({ objectId, label }: { objectId: string; label: string }) {
    const [copied, setCopied] = useState(false);
    const t = useCalendarT();
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(`${window.location.origin}${eventPath(objectId)}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setCopied(false);
        }
    };
    const shown = copied ? t("screen.copied") : label;
    return (
        <Button size="icon-sm" variant="ghost" aria-label={shown} title={shown} onClick={() => void copy()}>
            <Link2 />
        </Button>
    );
}

function EditorSkeleton() {
    return (
        <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-24 w-full" />
        </div>
    );
}

function Banner({ tone, children }: { tone: "warning" | "neutral"; children: ReactNode }) {
    return (
        <div role="status" className={cn("flex items-start gap-2 rounded-md border p-2.5 text-xs", tone === "warning" ? "border-warning-edge bg-warning-soft text-warning-ink" : "border-border bg-muted text-muted-foreground")}>
            <AlertTriangle aria-hidden className="mt-0.5 size-4" />
            <span>{children}</span>
        </div>
    );
}

function calendarOptions(calendars: readonly CalendarSummary[], currentId: string) {
    return calendars
        .filter((calendar) => (calendar.writable && calendar.components.includes("VEVENT")) || calendar.id === currentId)
        .map((calendar) => ({ value: calendar.id, label: calendar.name, icon: <ColorDot color={calendar.color} /> }));
}

function EditForm({
    form,
    setForm,
    detail,
    calendars,
    zone,
    preferences,
    errors,
    onChanged
}: {
    form: model.EditorForm;
    setForm: (form: model.EditorForm) => void;
    detail: EventDetail | null;
    calendars: readonly CalendarSummary[];
    zone: string;
    preferences: CalendarPreferences;
    errors: Partial<Record<model.FieldName, string>>;
    onChanged: () => void;
}) {
    const t = useCalendarT();
    const { t: ruleT, locale } = useRuleT();
    const ids = useId();
    const [zonesShown, setZonesShown] = useState(() => (form.startZone !== "" && form.startZone !== zone) || form.endZone !== form.startZone);
    const [customCategory, setCustomCategory] = useState("");
    const set = (change: Partial<model.EditorForm>) => setForm({ ...form, ...change });
    const errorText = (field: model.FieldName) => {
        const key = errors[field];
        if (!key) return null;
        return key === "checkInput" ? t("editor.checkField") : ruleT(`validation.${key}` as Parameters<typeof ruleT>[0]);
    };

    const inSeries = detail !== null && detail.recurrenceKey !== null && detail.series !== null && (detail.series.rule !== null || detail.series.rdates.length > 0);
    const exception = detail !== null && detail.event.recurrenceId !== null;
    const loadedRule = detail ? model.ruleOf(detail) : null;
    const duration = model.durationOf(form, zone);
    const startInstant = model.formInstant(form.startDate, form.startTime, form.startZone, zone);
    const endInstant = model.formInstant(form.endDate, form.endTime, form.endZone, zone);
    const otherZone = !form.allDay && ((form.startZone !== "" && form.startZone !== zone) || (form.endZone !== "" && form.endZone !== zone));
    const startValue: engine.DateValue | null = form.allDay ? { date: form.startDate } : startInstant ? { dateTime: `${form.startDate}T${form.startTime}:00`, tzid: form.startZone || null } : null;
    const categoryWords = model.DEFAULT_CATEGORIES.map((key) => t(`categories.${key}`));
    const readableZone = (value: string) => (value === "" ? t("zonePicker.floating") : engine.zoneLabel(value, startInstant ?? new Date(), locale));

    return (
        <div className="flex flex-col gap-4">
            {detail?.conflict ? <Banner tone="warning">{t("editor.conflict")}</Banner> : null}
            {detail && !detail.isOrganizer && form.attendees.length > 0 ? <Banner tone="neutral">{t("editor.notOrganizer")}</Banner> : null}
            {detail && !detail.isOrganizer ? <RespondBar detail={detail} zone={zone} onChanged={onChanged} /> : null}

            <Input
                aria-label={t("editor.titleField")}
                placeholder={t("editor.titlePlaceholder")}
                className="h-10 text-[0.9375rem] font-medium"
                value={form.summary}
                maxLength={500}
                onChange={(event) => set({ summary: event.target.value })}
            />

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <div className="flex min-w-0 flex-col gap-4">
                    <section className="flex flex-col gap-2" aria-labelledby={`${ids}-when`}>
                        <GroupHeading>
                            <span id={`${ids}-when`}>{t("editor.when")}</span>
                        </GroupHeading>
                        <div className="flex flex-wrap items-center gap-3">
                            <label className="flex items-center gap-2 text-[0.8125rem]" title={inSeries ? t("editor.allDayLocked") : undefined}>
                                <input type="checkbox" checked={form.allDay} disabled={inSeries} onChange={(event) => setForm(model.withAllDay(form, event.target.checked, zone))} className="accent-[hsl(var(--primary))]" />
                                {t("editor.allDay")}
                            </label>
                            {!form.allDay ? (
                                <Button size="xs" variant="ghost" aria-expanded={zonesShown} onClick={() => setZonesShown(!zonesShown)}>
                                    <Globe />
                                    {t("editor.timeZones")}
                                </Button>
                            ) : null}
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                            <FieldRow label={t("editor.starts")} htmlFor={`${ids}-start`} error={errorText("start") ?? errorText("allDay")}>
                                <div className="flex gap-2">
                                    <Input id={`${ids}-start`} type="date" className="min-w-0 flex-1 tabular-nums" value={form.startDate} onChange={(event) => setForm(model.withStart(form, event.target.value, form.startTime, zone))} />
                                    {!form.allDay ? (
                                        <Input type="time" aria-label={t("editor.startTime")} className="w-28 tabular-nums" value={form.startTime} onChange={(event) => setForm(model.withStart(form, form.startDate, event.target.value, zone))} />
                                    ) : null}
                                </div>
                                {zonesShown && !form.allDay ? <ZonePicker value={form.startZone} onChange={(value) => set({ startZone: value, endZone: form.endZone === form.startZone ? value : form.endZone })} allowFloating label={t("editor.startZone")} /> : null}
                            </FieldRow>
                            <FieldRow label={t("editor.ends")} htmlFor={`${ids}-end`} error={errorText("end")}>
                                <div className="flex gap-2">
                                    <Input id={`${ids}-end`} type="date" className="min-w-0 flex-1 tabular-nums" value={form.endDate} onChange={(event) => set({ endDate: event.target.value })} />
                                    {!form.allDay ? <Input type="time" aria-label={t("editor.endTime")} className="w-28 tabular-nums" value={form.endTime} onChange={(event) => set({ endTime: event.target.value })} /> : null}
                                </div>
                                {zonesShown && !form.allDay ? <ZonePicker value={form.endZone} onChange={(value) => set({ endZone: value })} allowFloating label={t("editor.endZone")} /> : null}
                            </FieldRow>
                        </div>
                        {!form.allDay ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <Select
                                    className="w-40"
                                    aria-label={t("editor.duration")}
                                    placeholder={t("editor.duration")}
                                    value={duration !== null && (model.DURATION_PRESETS as readonly number[]).includes(duration) ? String(duration) : ""}
                                    onValueChange={(minutes) => setForm(model.withDuration(form, Number(minutes), zone))}
                                    options={model.DURATION_PRESETS.map((minutes) => ({ value: String(minutes), label: t("editor.minutes", { count: minutes }) }))}
                                />
                                {otherZone && startInstant && endInstant ? (
                                    <p className="text-xs text-muted-foreground tabular-nums">
                                        {t("editor.localTime", {
                                            range: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: zone }).formatRange(startInstant, endInstant),
                                            zone: readableZone(zone)
                                        })}
                                    </p>
                                ) : null}
                            </div>
                        ) : null}
                    </section>

                    <section className="flex flex-col gap-2">
                        <GroupHeading>{t("editor.repeat")}</GroupHeading>
                        <RecurrenceEditor
                            value={form.repeat}
                            onChange={(repeat) => set({ repeat })}
                            start={startValue}
                            rule={loadedRule}
                            onReplace={() => set({ keepRule: false })}
                            lockedReason={exception ? t("editor.exceptionNoRule") : null}
                        />
                        {errorText("rule") ? (
                            <p role="alert" className="text-xs text-danger">
                                {errorText("rule")}
                            </p>
                        ) : null}
                    </section>

                    <FieldRow label={t("editor.location")} htmlFor={`${ids}-location`}>
                        <div className="relative">
                            <MapPin aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                            <Input id={`${ids}-location`} className="pl-8" value={form.location} maxLength={1000} onChange={(event) => set({ location: event.target.value })} />
                        </div>
                    </FieldRow>

                    <ConferenceField id={`${ids}-conference`} value={form.conference} onChange={(conference) => set({ conference })} error={errorText("conference")} title={form.summary} start={startInstant} />

                    <FieldRow label={t("editor.description")} htmlFor={`${ids}-description`}>
                        <Textarea id={`${ids}-description`} rows={4} value={form.description} maxLength={20_000} onChange={(event) => set({ description: event.target.value })} />
                    </FieldRow>

                    <Attachments attachments={form.attachments} onChange={(attachments) => set({ attachments })} error={errorText("attachments")} />

                    <section className="flex flex-col gap-2">
                        <GroupHeading>{t("editor.attendees")}</GroupHeading>
                        <AttendeesEditor
                            value={form.attendees}
                            onChange={(attendees) => set({ attendees })}
                            readOnly={false}
                            organizer={detail?.event.organizer ?? null}
                            when={
                                startInstant && endInstant
                                    ? {
                                          start: startInstant.toISOString(),
                                          end: endInstant.toISOString(),
                                          zone,
                                          onPick: (start, end) => {
                                              const startWall = wallOf(start, form.startZone || zone);
                                              const endWall = wallOf(end, form.endZone || zone);
                                              set({ startDate: startWall.slice(0, 10), startTime: startWall.slice(11, 16), endDate: endWall.slice(0, 10), endTime: endWall.slice(11, 16) });
                                          }
                                      }
                                    : null
                            }
                        />
                        {errorText("attendees") ? (
                            <p role="alert" className="text-xs text-danger">
                                {errorText("attendees")}
                            </p>
                        ) : null}
                    </section>
                </div>

                <div className="flex min-w-0 flex-col gap-4">
                    <FieldRow label={t("editor.calendar")} error={errorText("calendarId")}>
                        <Select aria-label={t("editor.calendar")} placeholder={t("editor.chooseCalendar")} value={form.calendarId} onValueChange={(calendarId) => set({ calendarId })} options={calendarOptions(calendars, form.calendarId)} />
                    </FieldRow>

                    <section className="flex flex-col gap-2">
                        <GroupHeading>{t("editor.reminders")}</GroupHeading>
                        <RemindersEditor value={form.alarms} onChange={(alarms) => set({ alarms })} allDay={form.allDay} zone={zone} />
                    </section>

                    <FieldRow label={t("editor.status")}>
                        <Select
                            aria-label={t("editor.status")}
                            value={form.status ?? NONE}
                            onValueChange={(status) => set({ status: status === NONE ? null : (status as engine.EventStatus) })}
                            options={[NONE, "CONFIRMED", "TENTATIVE", "CANCELLED"].map((status) => ({ value: status, label: t(`editor.statusOption.${status as "none"}`) }))}
                        />
                    </FieldRow>
                    <FieldRow label={t("editor.showAs")}>
                        <Select
                            aria-label={t("editor.showAs")}
                            value={form.transparency}
                            onValueChange={(transparency) => set({ transparency: transparency as engine.Transparency })}
                            options={(["OPAQUE", "TRANSPARENT"] as const).map((value) => ({ value, label: t(`editor.transparency.${value}`) }))}
                        />
                    </FieldRow>
                    <FieldRow label={t("editor.visibility")} hint={t(`editor.visibilityHint.${form.classification}`)}>
                        <Select
                            aria-label={t("editor.visibility")}
                            value={form.classification}
                            onValueChange={(classification) => set({ classification: classification as engine.Classification })}
                            options={(["PUBLIC", "PRIVATE", "CONFIDENTIAL"] as const).map((value) => ({ value, label: t(`editor.classification.${value}`) }))}
                        />
                    </FieldRow>
                    <FieldRow label={t("editor.kind")}>
                        <Select
                            aria-label={t("editor.kind")}
                            value={form.kind}
                            onValueChange={(kind) => set({ kind: kind as engine.EventKind })}
                            options={(["default", "outOfOffice", "focusTime", ...(form.kind === "workingLocation" ? (["workingLocation"] as const) : [])] as const).map((value) => ({ value, label: t(`editor.kinds.${value}`) }))}
                        />
                    </FieldRow>

                    <FieldRow label={t("editor.color")} error={errorText("color")}>
                        <div role="radiogroup" aria-label={t("editor.color")} className="flex flex-wrap gap-1.5">
                            <button
                                type="button"
                                role="radio"
                                aria-checked={form.color === null}
                                aria-label={t("editor.calendarColor")}
                                title={t("editor.calendarColor")}
                                onClick={() => set({ color: null })}
                                className={cn("flex size-6 items-center justify-center rounded-full border", form.color === null ? "border-foreground" : "border-border")}
                            >
                                <ColorDot color={calendars.find((calendar) => calendar.id === form.calendarId)?.color ?? "#7f7f7f"} />
                            </button>
                            {model.EVENT_COLORS.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    role="radio"
                                    aria-checked={form.color?.toLowerCase() === color}
                                    aria-label={color}
                                    title={color}
                                    onClick={() => set({ color })}
                                    className={cn("size-6 rounded-full border-2", form.color?.toLowerCase() === color ? "border-foreground" : "border-transparent")}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                        </div>
                    </FieldRow>

                    <FieldRow label={t("editor.categories")}>
                        {form.categories.length > 0 ? (
                            <ul className="flex flex-wrap gap-1">
                                {form.categories.map((category) => (
                                    <li key={category}>
                                        <button
                                            type="button"
                                            className="inline-flex max-w-full items-center gap-1 truncate rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                                            aria-label={t("editor.removeCategory", { category })}
                                            title={t("editor.removeCategory", { category })}
                                            onClick={() => set({ categories: form.categories.filter((entry) => entry !== category) })}
                                        >
                                            {category}
                                            <span aria-hidden>×</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        {form.categories.length < 20 ? (
                            <div className="flex gap-2">
                                <Select
                                    className="min-w-0 flex-1"
                                    aria-label={t("editor.addCategory")}
                                    placeholder={t("editor.addCategory")}
                                    value=""
                                    onValueChange={(category) => set({ categories: [...form.categories, category] })}
                                    options={categoryWords.filter((word) => !form.categories.includes(word)).map((word) => ({ value: word, label: word }))}
                                />
                            </div>
                        ) : null}
                        {form.categories.length < 20 ? (
                            <Input
                                aria-label={t("editor.customCategory")}
                                placeholder={t("editor.customCategory")}
                                value={customCategory}
                                maxLength={100}
                                onChange={(event) => setCustomCategory(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key !== "Enter") return;
                                    event.preventDefault();
                                    const word = customCategory.trim();
                                    if (word && !form.categories.includes(word)) set({ categories: [...form.categories, word] });
                                    setCustomCategory("");
                                }}
                            />
                        ) : null}
                    </FieldRow>

                    <FieldRow label={t("editor.url")} htmlFor={`${ids}-url`} error={errorText("url")}>
                        <Input id={`${ids}-url`} type="url" inputMode="url" placeholder="https://" value={form.url} onChange={(event) => set({ url: event.target.value })} />
                    </FieldRow>
                </div>
            </div>
            <p className="sr-only">{preferences.keyboardShortcuts ? t("editor.shortcutsHint") : ""}</p>
        </div>
    );
}

/** An event this reader may only look at, or answer. */
function ViewMode({ detail, form, calendars, zone, onChanged }: { detail: EventDetail; form: model.EditorForm; calendars: readonly CalendarSummary[]; zone: string; onChanged: () => void }) {
    const t = useCalendarT();
    const { words, locale } = useRuleT();
    const event = detail.event;
    const calendar = calendars.find((entry) => entry.id === detail.calendarId);
    const rule = model.ruleOf(detail);
    const allDay = "date" in event.start;
    const start = engine.valueToInstant(event.start, zone);
    const end = engine.valueToInstant(event.end, zone);
    const when = allDay
        ? new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).formatRange(new Date(`${form.startDate}T12:00:00Z`), new Date(`${form.endDate}T12:00:00Z`))
        : new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: zone }).formatRange(start, end);

    return (
        <div className="flex flex-col gap-4">
            {detail.conflict ? <Banner tone="warning">{t("editor.conflict")}</Banner> : null}
            <div className="flex items-start gap-2">
                <ColorDot color={event.color ?? calendar?.color ?? "#7f7f7f"} className="mt-2" />
                <div className="min-w-0">
                    <p className={cn("break-words text-[0.9375rem] font-medium", event.status === "CANCELLED" && "line-through")}>{detail.busyOnly ? t("screen.busy") : event.summary || t("screen.untitled")}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                        <CalendarClock aria-hidden className="size-4" />
                        {when}
                    </p>
                    {rule ? <p className="text-xs text-muted-foreground">{engine.summarizeRule(rule, words, locale)}</p> : null}
                </div>
            </div>
            {!detail.busyOnly ? <RespondBar detail={detail} zone={zone} onChanged={onChanged} /> : null}
            {event.location ? (
                <p className="flex items-start gap-2 text-[0.8125rem]">
                    <MapPin aria-hidden className="mt-0.5 size-4 text-foreground-subtle" />
                    <span className="min-w-0 break-words">{event.location}</span>
                </p>
            ) : null}
            {event.conference && model.isWebLink(event.conference) ? (
                <Button asChild variant="outline" size="sm" className="self-start">
                    <a href={event.conference} target="_blank" rel="noopener noreferrer">
                        <Video />
                        {t("editor.join")}
                    </a>
                </Button>
            ) : null}
            {event.description ? <Linkified text={event.description} className="text-[0.8125rem] text-muted-foreground" /> : null}
            {event.attachments.length > 0 ? <Attachments attachments={event.attachments} /> : null}
            {calendar ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ColorDot color={calendar.color} />
                    {calendar.name}
                </p>
            ) : null}
            {event.alarms.length > 0 ? (
                <section className="flex flex-col gap-1">
                    <GroupHeading>{t("editor.reminders")}</GroupHeading>
                    <ul className="text-xs text-muted-foreground tabular-nums">
                        {form.alarms.map((alarm, index) => (
                            <li key={index}>{describeAlarm(alarm, allDay, words, locale, zone)}</li>
                        ))}
                    </ul>
                </section>
            ) : null}
            {event.attendees.length > 0 ? (
                <section className="flex flex-col gap-2">
                    <GroupHeading>{t("editor.attendees")}</GroupHeading>
                    <AttendeesEditor value={form.attendees} onChange={() => undefined} readOnly organizer={event.organizer} when={null} />
                </section>
            ) : null}
            {event.url && model.isWebLink(event.url) ? (
                <a href={event.url} target="_blank" rel="noopener noreferrer" className="truncate text-xs text-muted-foreground underline underline-offset-2">
                    {event.url}
                </a>
            ) : null}
            {!allDay ? <p className="text-xs text-foreground-subtle">{t("editor.shownIn", { zone: engine.zoneLabel(zone, start, locale), time: formatInstant(start, locale, zone, { timeStyle: "short" }) })}</p> : null}
        </div>
    );
}

/** The invited reader's own answer: for this occurrence, or the whole series. */
export function RespondBar({ detail, zone, onChanged }: { detail: EventDetail; zone: string; onChanged: () => void }) {
    const t = useCalendarT();
    const toast = useToast();
    const mine = model.myAttendee(detail);
    const repeating = detail.series !== null && (detail.series.rule !== null || detail.series.rdates.length > 0);
    const [reach, setReach] = useState<"this" | "series">("this");
    const [answer, setAnswer] = useState<engine.PartStat | null>(mine?.partstat ?? null);
    const [busy, setBusy] = useState(false);
    if (!mine) return null;

    const respond = async (partstat: "ACCEPTED" | "TENTATIVE" | "DECLINED") => {
        if (busy) return;
        const previous = answer;
        setAnswer(partstat);
        setBusy(true);
        try {
            await unwrap(
                () =>
                    eventActions.respondToEventAction({
                        objectId: detail.objectId,
                        recurrenceKey: repeating && reach === "this" ? detail.recurrenceKey : null,
                        partstat,
                        zone
                    }),
                t("screen.failed")
            );
            onChanged();
        } catch (caught) {
            setAnswer(previous);
            toast.show({ key: "calendar-respond-failed", title: t("respond.failed"), body: caught instanceof Error ? caught.message : undefined });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("respond.label")}>
            <span className="text-xs text-muted-foreground">{t("respond.question")}</span>
            {(["ACCEPTED", "TENTATIVE", "DECLINED"] as const).map((partstat) => (
                <Button key={partstat} size="sm" variant={answer === partstat ? "secondary" : "outline"} aria-pressed={answer === partstat} disabled={busy} onClick={() => void respond(partstat)}>
                    {t(`respond.${partstat}`)}
                </Button>
            ))}
            {repeating ? (
                <Select
                    className="w-40"
                    aria-label={t("respond.reach")}
                    value={reach}
                    onValueChange={(value) => setReach(value as "this" | "series")}
                    options={[
                        { value: "this", label: t("respond.thisOne") },
                        { value: "series", label: t("respond.series") }
                    ]}
                />
            ) : null}
        </div>
    );
}

/** The meeting link, and the button that makes a Polaris one. */
function ConferenceField({ id, value, onChange, error, title, start }: { id: string; value: string; onChange: (link: string) => void; error: string | null; title: string; start: Date | null }) {
    const t = useCalendarT();
    const [busy, setBusy] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const create = async () => {
        if (busy) return;
        setBusy(true);
        setRefused(null);
        try {
            const answer = await unwrap(() => meetingActions.createMeetingLinkAction({ title, start: start ? start.toISOString() : null }), t("screen.failed"));
            onChange(answer.link);
        } catch (caught) {
            setRefused(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };
    return (
        <FieldRow label={t("editor.conference")} htmlFor={id} error={error ?? refused}>
            <div className="flex flex-wrap gap-2">
                <div className="relative min-w-0 flex-1">
                    <Video aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                    <Input id={id} type="url" inputMode="url" className="pl-8" placeholder="https://" value={value} onChange={(event) => onChange(event.target.value)} />
                </div>
                {value === "" ? (
                    <Button size="sm" variant="outline" aria-disabled={busy} onClick={() => void create()}>
                        <Video />
                        {busy ? t("editor.addingMeeting") : t("editor.addMeeting")}
                    </Button>
                ) : null}
            </div>
        </FieldRow>
    );
}

/** Links attached to the event, opened after saying where they lead; added and
 *  removed here when the event can be changed. */
function Attachments({ attachments, onChange, error }: { attachments: readonly model.AttachmentDraft[]; onChange?: (attachments: model.AttachmentDraft[]) => void; error?: string | null }) {
    const t = useCalendarT();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [link, setLink] = useState("");
    const [name, setName] = useState("");
    const linkOk = model.isWebLink(link.trim());
    const addBlocked = link.trim() === "" ? t("editor.attachmentIncomplete") : !linkOk ? t("editor.attachmentBadLink") : attachments.some((entry) => entry.uri === link.trim()) ? t("editor.attachmentTwice") : null;
    const add = () => {
        if (!onChange || addBlocked) return;
        onChange([...attachments, { uri: link.trim(), name: name.trim(), mime: "" }]);
        setLink("");
        setName("");
    };
    if (!onChange && attachments.length === 0) return null;
    const open = async (uri: string) => {
        let host = uri;
        try {
            host = new URL(uri).host;
        } catch {
            return;
        }
        if (await confirm({ title: t("editor.openLinkTitle"), description: t("editor.openLinkBody", { host }), confirmLabel: t("editor.openLink") })) {
            window.open(uri, "_blank", "noopener,noreferrer");
        }
    };
    return (
        <section className="flex flex-col gap-1">
            <GroupHeading>{t("editor.attachments")}</GroupHeading>
            <ul className="flex flex-col">
                {attachments.map((attachment, index) => {
                    const name = attachment.name || attachment.uri;
                    const linkable = model.isWebLink(attachment.uri);
                    return (
                        <li key={`${attachment.uri}-${index}`} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-card-hover">
                            <Paperclip aria-hidden className="size-4 text-foreground-subtle" />
                            <span className="min-w-0 flex-1 truncate text-[0.8125rem]" title={name}>
                                {name}
                            </span>
                            {linkable ? (
                                <Button size="icon-sm" variant="ghost" aria-label={t("editor.openAttachment", { name })} title={t("editor.openAttachment", { name })} onClick={() => void open(attachment.uri)}>
                                    <ExternalLink />
                                </Button>
                            ) : null}
                            {onChange ? (
                                <Button size="icon-sm" variant="ghost" aria-label={t("editor.removeAttachment", { name })} title={t("editor.removeAttachment", { name })} onClick={() => onChange(attachments.filter((_, at) => at !== index))}>
                                    <Trash2 />
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
            {onChange && attachments.length < 20 ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                    <Input type="url" inputMode="url" aria-label={t("editor.attachmentLink")} placeholder="https://" className="min-w-0 flex-1" value={link} onChange={(event) => setLink(event.target.value)} />
                    <Input aria-label={t("editor.attachmentName")} placeholder={t("editor.attachmentName")} className="min-w-0 sm:w-40" value={name} maxLength={300} onChange={(event) => setName(event.target.value)} />
                    <Button size="sm" variant="outline" aria-disabled={addBlocked !== null} title={addBlocked ?? undefined} className={cn(addBlocked !== null && "opacity-50")} onClick={add}>
                        {t("editor.addAttachment")}
                    </Button>
                </div>
            ) : null}
            {link.trim() !== "" && !linkOk ? (
                <p role="alert" className="text-xs text-danger">
                    {t("editor.attachmentBadLink")}
                </p>
            ) : error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
            {confirmElement}
        </section>
    );
}
