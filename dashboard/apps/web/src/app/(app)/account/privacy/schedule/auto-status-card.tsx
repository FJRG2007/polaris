"use client";

/**
 * Automatic status: "In a call" while on a Polaris call, "In a meeting" during
 * a busy calendar event, each either shown as the reason or turning on do not
 * disturb. Beside the weekly schedule because both answer the same question -
 * what to appear as when you are not there to say - and a status picked by
 * hand still beats either.
 */

import { useState, useTransition } from "react";
import {
    MAX_AUTO_PRESENCE_CALENDARS,
    MAX_AUTO_PRESENCE_MARGIN,
    autoPresenceSchema,
    type AutoPresence,
    type AutoPresenceEffect
} from "@polaris/core";
import { saveAutoPresenceAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Checkbox,
    Select,
    Switch
} from "@polaris/ui";

/** The margins offered, in minutes. */
const MARGINS = [0, 5, 10, 15, MAX_AUTO_PRESENCE_MARGIN];

export function AutoStatusCard({
    initial,
    calendars,
    isAdmin
}: {
    initial: AutoPresence;
    /** Whether the reader may install apps, which decides what a missing
     *  Calendar app is answered with. */
    isAdmin: boolean;
    /** The account's own calendars, or null when no Calendar app is installed. */
    calendars: readonly { id: string; name: string; color: string }[] | null;
}) {
    const t = useTranslations("accountPrivacy");
    const tc = useTranslations("common");
    const [saved, setSaved] = useState(initial);
    const [draft, setDraft] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [pending, startTransition] = useTransition();

    const checked = autoPresenceSchema.safeParse(draft);
    const changed = JSON.stringify(draft) !== JSON.stringify(saved);
    const meeting = draft.meeting;
    const noCalendarApp = calendars === null;

    function save() {
        if (!checked.success) return;
        const previous = saved;
        const next = checked.data;
        setError(null);
        setDone(false);
        setSaved(next);
        startTransition(async () => {
            const result = await saveAutoPresenceAction(next);
            if (result.error) {
                setSaved(previous);
                setError(result.error);
            } else setDone(true);
        });
    }

    const setMeeting = (patch: Partial<AutoPresence["meeting"]>) =>
        setDraft({ ...draft, meeting: { ...meeting, ...patch } });

    const effects = (
        value: AutoPresenceEffect,
        onChange: (next: AutoPresenceEffect) => void,
        disabled: boolean
    ) => (
        <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0 text-muted-foreground">{t("auto.effect")}</span>
            <Select
                value={value}
                disabled={disabled}
                aria-label={t("auto.effect")}
                className="w-56 max-w-full"
                onValueChange={(next) => onChange(next === "busy" ? "busy" : "status")}
                options={[
                    { value: "status", label: t("auto.effectStatus") },
                    { value: "busy", label: t("auto.effectBusy") }
                ]}
            />
        </label>
    );

    const margin = (label: string, value: number, onChange: (next: number) => void) => (
        <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="truncate text-muted-foreground" title={label}>
                {label}
            </span>
            <Select
                value={String(value)}
                disabled={!meeting.enabled || noCalendarApp}
                aria-label={label}
                className="w-28"
                onValueChange={(next) => onChange(Number(next))}
                options={MARGINS.map((minutes) => ({
                    value: String(minutes),
                    label: String(minutes)
                }))}
            />
        </label>
    );

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("auto.title")}</CardTitle>
                <p className="text-xs text-muted-foreground">{t("auto.description")}</p>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0">
                            <span className="block font-medium">{t("auto.call")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("auto.callHint")}
                            </span>
                        </span>
                        <Switch
                            checked={draft.call.enabled}
                            onChange={(enabled) =>
                                setDraft({ ...draft, call: { ...draft.call, enabled } })
                            }
                            aria-label={t("auto.call")}
                        />
                    </label>
                    {effects(
                        draft.call.effect,
                        (effect) => setDraft({ ...draft, call: { ...draft.call, effect } }),
                        !draft.call.enabled
                    )}
                </div>

                <div className="flex flex-col gap-2">
                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0">
                            <span className="block font-medium">{t("auto.meeting")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {noCalendarApp
                                    ? t(isAdmin ? "auto.noCalendarApp" : "auto.noCalendarAppMember")
                                    : t("auto.meetingHint")}
                            </span>
                        </span>
                        <Switch
                            checked={meeting.enabled}
                            disabled={noCalendarApp && !meeting.enabled}
                            onChange={(enabled) => setMeeting({ enabled })}
                            aria-label={t("auto.meeting")}
                        />
                    </label>
                    {!noCalendarApp && (
                        <>
                            {effects(
                                meeting.effect,
                                (effect) => setMeeting({ effect }),
                                !meeting.enabled
                            )}
                            <fieldset
                                className="flex flex-col gap-1.5 text-sm"
                                disabled={!meeting.enabled}
                            >
                                <legend className="mb-1 text-muted-foreground">
                                    {t("auto.calendars")}
                                </legend>
                                <label className="flex items-center gap-2">
                                    <Checkbox
                                        checked={meeting.calendars === null}
                                        onChange={(event) =>
                                            setMeeting({
                                                calendars: event.target.checked
                                                    ? null
                                                    : calendars
                                                          .slice(0, MAX_AUTO_PRESENCE_CALENDARS)
                                                          .map((calendar) => calendar.id)
                                            })
                                        }
                                    />
                                    <span className="min-w-0 truncate">
                                        {t("auto.allCalendars")}
                                    </span>
                                </label>
                                {calendars.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                        {t("auto.noCalendars")}
                                    </p>
                                ) : (
                                    meeting.calendars !== null &&
                                    calendars.map((calendar) => {
                                        const picked = meeting.calendars ?? [];
                                        const isPicked = picked.includes(calendar.id);
                                        return (
                                            <label
                                                key={calendar.id}
                                                className="flex min-w-0 items-center gap-2 pl-6"
                                            >
                                                <Checkbox
                                                    checked={isPicked}
                                                    disabled={
                                                        !isPicked &&
                                                        picked.length >= MAX_AUTO_PRESENCE_CALENDARS
                                                    }
                                                    onChange={(event) =>
                                                        setMeeting({
                                                            calendars: event.target.checked
                                                                ? [...picked, calendar.id]
                                                                : picked.filter(
                                                                      (id) => id !== calendar.id
                                                                  )
                                                        })
                                                    }
                                                />
                                                <span
                                                    aria-hidden="true"
                                                    className="size-2.5 shrink-0 rounded-full"
                                                    style={{ backgroundColor: calendar.color }}
                                                />
                                                <span
                                                    className="min-w-0 truncate"
                                                    title={calendar.name}
                                                >
                                                    {calendar.name}
                                                </span>
                                            </label>
                                        );
                                    })
                                )}
                                {meeting.calendars !== null &&
                                calendars.length > MAX_AUTO_PRESENCE_CALENDARS ? (
                                    <p className="pl-6 text-xs text-muted-foreground">
                                        {t("auto.calendarLimit", {
                                            count: MAX_AUTO_PRESENCE_CALENDARS
                                        })}
                                    </p>
                                ) : null}
                            </fieldset>
                            <label className="flex items-center justify-between gap-3 text-sm">
                                <span className="min-w-0">{t("auto.allDay")}</span>
                                <Switch
                                    checked={meeting.allDay}
                                    disabled={!meeting.enabled}
                                    onChange={(allDay) => setMeeting({ allDay })}
                                    aria-label={t("auto.allDay")}
                                />
                            </label>
                            <div className="flex flex-wrap gap-3">
                                {margin(t("auto.before"), meeting.beforeMinutes, (beforeMinutes) =>
                                    setMeeting({ beforeMinutes })
                                )}
                                {margin(t("auto.after"), meeting.afterMinutes, (afterMinutes) =>
                                    setMeeting({ afterMinutes })
                                )}
                            </div>
                        </>
                    )}
                </div>

                {error ? <p className="text-xs text-danger">{error}</p> : null}
                {done && !changed ? (
                    <p className="text-xs text-muted-foreground">{t("auto.saved")}</p>
                ) : null}
                <div className="flex justify-end">
                    <Button
                        size="sm"
                        onClick={save}
                        disabled={pending || !changed || !checked.success}
                    >
                        {tc("actions.save")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
