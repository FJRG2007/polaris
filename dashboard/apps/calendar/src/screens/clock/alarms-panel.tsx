"use client";

/**
 * Alarms: each one's time, its repeat, its label, when it rings next and a
 * switch to turn it off; a menu to edit, skip the next ring or delete it; and
 * the dialog that makes or changes one.
 */

import { useState } from "react";
import * as words from "./words";
import { preview } from "./sound";
import { useCalendarT } from "../i18n";
import * as model from "../../lib/clock/model";
import { hostUi } from "@polaris/app-host/client";
import * as clockActions from "../../actions/clock";
import { mutate, useServerNow, type ClockRead } from "./store";
import { AlarmClock, MoreHorizontal, Pencil, Plus, SkipForward, Trash2, Volume2 } from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    Select,
    Skeleton,
    Switch,
    useToast
} from "@polaris/ui";

type Draft = model.AlarmInput & { readonly id: string | null };

const NEW_ALARM: Draft = {
    id: null,
    time: "07:00",
    days: 0,
    label: "",
    sound: "chime",
    snoozeMinutes: 10,
    enabled: true
};

export function AlarmsPanel({ clock, zone, hour12 }: { clock: ClockRead; zone: string; hour12: boolean }) {
    const t = useCalendarT();
    const toast = useToast();
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [draft, setDraft] = useState<Draft | null>(null);
    const now = useServerNow(clock.skew, 30_000);
    const alarms = clock.snapshot?.alarms ?? null;
    const failed = (message: string) => toast.show({ key: "calendar-time", title: message || t("screen.failed") });

    const change = (
        alarm: model.AlarmView,
        request: Parameters<typeof clockActions.changeAlarmAction>[0],
        optimistic: (view: model.AlarmView) => model.AlarmView | null
    ) =>
        void mutate(
            clock,
            () => clockActions.changeAlarmAction(request),
            (snapshot) => ({
                ...snapshot,
                alarms: snapshot.alarms
                    .map((entry) => (entry.id === alarm.id ? optimistic(entry) : entry))
                    .filter((entry): entry is model.AlarmView => entry !== null)
            }),
            failed
        );

    const remove = async (alarm: model.AlarmView) => {
        const ok = await confirm({
            title: t("time.alarms.deleteTitle"),
            description: t("time.alarms.deleteBody", {
                time: words.wallTimeText(alarm.time, locale, hour12)
            }),
            confirmLabel: t("time.delete"),
            danger: true
        });
        if (ok) change(alarm, { id: alarm.id, change: "delete" }, () => null);
    };

    return (
        <section aria-label={t("time.tabs.alarms")} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={zone}>
                    {t("time.alarms.zone", { zone })}
                </p>
                <Button size="sm" onClick={() => setDraft(NEW_ALARM)} disabled={alarms !== null && alarms.length >= model.MAX_ALARMS}>
                    <Plus />
                    {t("time.alarms.add")}
                </Button>
            </div>

            {alarms === null ? (
                clock.error ? (
                    <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                        <p className="text-muted-foreground">{t("time.loadFailed")}</p>
                        <Button size="sm" variant="outline" onClick={clock.refresh}>
                            {t("screen.retry")}
                        </Button>
                    </div>
                ) : (
                    <ul className="flex flex-col gap-2" aria-hidden>
                        {[0, 1, 2].map((index) => (
                            <Skeleton key={index} className="h-[4.5rem] w-full" />
                        ))}
                    </ul>
                )
            ) : alarms.length === 0 ? (
                <EmptyState
                    icon={<AlarmClock />}
                    title={t("time.alarms.emptyTitle")}
                    description={t("time.alarms.emptyBody")}
                    action={
                        <Button size="sm" onClick={() => setDraft(NEW_ALARM)}>
                            <Plus />
                            {t("time.alarms.add")}
                        </Button>
                    }
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {alarms.map((alarm) => {
                        const next = alarm.nextFireAt ? new Date(alarm.nextFireAt).getTime() : null;
                        return (
                            <li key={alarm.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                                <button
                                    type="button"
                                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                                    onClick={() => setDraft({ ...alarm })}
                                    aria-label={t("time.alarms.editOne", {
                                        time: words.wallTimeText(alarm.time, locale, hour12)
                                    })}
                                >
                                    <span
                                        className={cn(
                                            "text-2xl font-semibold tabular-nums tracking-tight",
                                            !alarm.enabled && "text-foreground-subtle"
                                        )}
                                    >
                                        {words.wallTimeText(alarm.time, locale, hour12)}
                                    </span>
                                    <span className="w-full truncate text-xs text-muted-foreground">
                                        {[
                                            alarm.label,
                                            words.repeatText(alarm.days, t, locale, format.weekStartsOn),
                                            alarm.zone !== zone ? alarm.zone.replace(/_/g, " ") : null
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    </span>
                                    {alarm.enabled && next !== null ? (
                                        <span className="text-xs text-foreground-subtle">
                                            {alarm.snoozed
                                                ? t("time.alarms.snoozedUntil", {
                                                      time: words.instantTimeText(next, locale, zone, hour12)
                                                  })
                                                : t("time.alarms.ringsIn", {
                                                      length: words.lengthText(next - now, t)
                                                  })}
                                        </span>
                                    ) : null}
                                </button>
                                <Switch
                                    checked={alarm.enabled}
                                    aria-label={t("time.alarms.toggle", {
                                        time: words.wallTimeText(alarm.time, locale, hour12)
                                    })}
                                    onChange={(enabled) =>
                                        change(alarm, { id: alarm.id, change: "enable", enabled }, (entry) => ({
                                            ...entry,
                                            enabled,
                                            snoozed: false,
                                            nextFireAt: enabled
                                                ? model.nextAlarmFire(entry, new Date(now)).toISOString()
                                                : null
                                        }))
                                    }
                                />
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            aria-label={t("time.more")}
                                            title={t("time.more")}
                                        >
                                            <MoreHorizontal />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem onSelect={() => setDraft({ ...alarm })}>
                                            <Pencil />
                                            {t("time.edit")}
                                        </DropdownMenuItem>
                                        {alarm.enabled && alarm.days !== 0 && next !== null ? (
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    change(alarm, { id: alarm.id, change: "skip" }, (entry) => ({
                                                        ...entry,
                                                        snoozed: false,
                                                        nextFireAt: model
                                                            .nextAlarmFire(entry, new Date(next))
                                                            .toISOString()
                                                    }))
                                                }
                                            >
                                                <SkipForward />
                                                {t("time.alarms.skip")}
                                            </DropdownMenuItem>
                                        ) : null}
                                        <DropdownMenuItem onSelect={() => void remove(alarm)}>
                                            <Trash2 />
                                            {t("time.delete")}
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </li>
                        );
                    })}
                </ul>
            )}

            {draft ? (
                <AlarmDialog
                    draft={draft}
                    zone={zone}
                    onClose={() => setDraft(null)}
                    onDelete={
                        draft.id
                            ? () => {
                                  const alarm = alarms?.find((entry) => entry.id === draft.id);
                                  setDraft(null);
                                  if (alarm) void remove(alarm);
                              }
                            : null
                    }
                    onSave={async (input) => {
                        const ok = await mutate(
                            clock,
                            () => clockActions.saveAlarmAction({ id: draft.id, alarm: input, zone }),
                            null,
                            failed
                        );
                        if (ok) setDraft(null);
                    }}
                />
            ) : null}
            {confirmElement}
        </section>
    );
}

function AlarmDialog({
    draft,
    zone,
    onClose,
    onSave,
    onDelete
}: {
    draft: Draft;
    zone: string;
    onClose: () => void;
    onSave: (input: model.AlarmInput) => Promise<void>;
    onDelete: (() => void) | null;
}) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [form, setForm] = useState<model.AlarmInput>({
        time: draft.time,
        days: draft.days,
        label: draft.label,
        sound: draft.sound,
        snoozeMinutes: draft.snoozeMinutes,
        enabled: draft.id === null ? true : draft.enabled
    });
    const [busy, setBusy] = useState(false);
    const check = model.alarmInputSchema.safeParse(form);
    const timeMissing = form.time === "";
    const labelTooLong = form.label.trim().length > model.CLOCK_LABEL_MAX;
    const unchanged =
        draft.id !== null &&
        form.time === draft.time &&
        form.days === draft.days &&
        form.label.trim() === draft.label &&
        form.sound === draft.sound &&
        form.snoozeMinutes === draft.snoozeMinutes &&
        form.enabled === draft.enabled;
    const next = check.success
        ? model.nextAlarmFire({ time: form.time, days: form.days, zone }, new Date())
        : null;

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-md">
                <DialogTitle>{draft.id ? t("time.alarms.editTitle") : t("time.alarms.newTitle")}</DialogTitle>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!check.success || busy || unchanged) return;
                        setBusy(true);
                        await onSave(check.data);
                        setBusy(false);
                    }}
                >
                    <label className="flex flex-col gap-1 text-[0.8125rem]">
                        <span>
                            {t("time.alarms.time")}
                            <span aria-hidden className="text-danger">
                                {" *"}
                            </span>
                        </span>
                        <Input
                            type="time"
                            required
                            value={form.time}
                            onChange={(event) => setForm({ ...form, time: event.target.value })}
                            className="w-36 text-lg tabular-nums"
                        />
                    </label>

                    <fieldset className="flex flex-col gap-1.5">
                        <legend className="text-[0.8125rem]">{t("time.alarms.repeat")}</legend>
                        <div className="flex flex-wrap gap-1.5">
                            {words.weekOrder(format.weekStartsOn).map((weekday) => {
                                const on = model.hasDay(form.days, weekday);
                                return (
                                    <button
                                        key={weekday}
                                        type="button"
                                        aria-pressed={on}
                                        title={words.weekdayName(weekday, locale, "long")}
                                        onClick={() => setForm({ ...form, days: model.toggleDay(form.days, weekday) })}
                                        className={cn(
                                            "flex size-9 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                                            on
                                                ? "border-primary bg-primary text-primary-foreground"
                                                : "border-border bg-surface text-muted-foreground hover:bg-muted"
                                        )}
                                    >
                                        {words.weekdayName(weekday, locale, "narrow")}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {words.repeatText(form.days, t, locale, format.weekStartsOn)}
                            {next
                                ? ` · ${t("time.alarms.nextOn", {
                                      when: new Intl.DateTimeFormat(locale, {
                                          weekday: "short",
                                          day: "numeric",
                                          month: "short",
                                          hour: "numeric",
                                          minute: "2-digit",
                                          hour12: format.preferences.clock === "12h",
                                          timeZone: zone
                                      }).format(next)
                                  })}`
                                : null}
                        </p>
                    </fieldset>

                    <label className="flex flex-col gap-1 text-[0.8125rem]">
                        <span>{t("time.label")}</span>
                        <Input
                            value={form.label}
                            maxLength={model.CLOCK_LABEL_MAX + 20}
                            placeholder={t("time.alarms.labelHint")}
                            aria-invalid={labelTooLong || undefined}
                            onChange={(event) => setForm({ ...form, label: event.target.value })}
                        />
                        {labelTooLong ? (
                            <span className="text-xs text-danger">
                                {t("time.labelTooLong", { max: model.CLOCK_LABEL_MAX })}
                            </span>
                        ) : null}
                    </label>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <SoundField value={form.sound} onChange={(sound) => setForm({ ...form, sound })} />
                        <div className="flex flex-col gap-1 text-[0.8125rem]">
                            <span>{t("time.alarms.snooze")}</span>
                            <Select
                                aria-label={t("time.alarms.snooze")}
                                value={String(form.snoozeMinutes)}
                                onValueChange={(value) => setForm({ ...form, snoozeMinutes: Number(value) })}
                                options={model.SNOOZE_MINUTES.map((minutes) => ({
                                    value: String(minutes),
                                    label: t("time.minutes", { count: minutes })
                                }))}
                            />
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                        {onDelete ? (
                            <Button type="button" variant="ghost" onClick={onDelete} disabled={busy}>
                                <Trash2 />
                                {t("time.delete")}
                            </Button>
                        ) : null}
                        <span className="flex-1" />
                        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                            {t("time.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={!check.success || unchanged || busy || timeMissing}
                            disabled={busy}
                        >
                            {t("time.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** The sound a ring makes, with a button to hear it. */
export function SoundField({ value, onChange }: { value: model.ClockSound; onChange: (sound: model.ClockSound) => void }) {
    const t = useCalendarT();
    return (
        <div className="flex flex-col gap-1 text-[0.8125rem]">
            <span>{t("time.sound")}</span>
            <div className="flex items-center gap-1.5">
                <Select
                    className="min-w-0 flex-1"
                    aria-label={t("time.sound")}
                    value={value}
                    onValueChange={(next) => onChange(next as model.ClockSound)}
                    options={model.CLOCK_SOUNDS.map((sound) => ({ value: sound, label: t(`time.sounds.${sound}`) }))}
                />
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("time.preview")}
                    title={t("time.preview")}
                    onClick={() => preview(value)}
                >
                    <Volume2 />
                </Button>
            </div>
        </div>
    );
}
