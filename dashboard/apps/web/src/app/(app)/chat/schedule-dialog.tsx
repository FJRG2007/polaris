"use client";

/**
 * Choosing when a message goes.
 *
 * Three presses for the answer almost everybody gives - later today, tomorrow
 * morning, Monday morning - and a date and a time underneath for the one they do
 * not. A dialog that opened straight onto two empty fields would make the common
 * case the slow one.
 *
 * Everything here is read in the account's own zone rather than the browser's,
 * which is the whole reason `zonedInstant` exists: "Monday at nine" is a reading
 * on somebody's clock, and which instant that is depends on whose. Somebody
 * working to another zone would otherwise schedule for nine in the morning and
 * have it go at nine in a zone they have never been in.
 *
 * The moment is spelled out under the fields in the same words the rest of
 * Polaris writes dates in, because a date field is the one control people
 * routinely fill in wrong: the eighth of September and the ninth of August are
 * one keystroke apart and read identically to somebody scanning.
 */

import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useMemo, useState } from "react";
import { CalendarClock } from "lucide-react";
import { MORNING, plusDays, weekdayOf, type Reading } from "./reminder-times";
import { useDisplayFormat, useDisplayPreferences } from "@/components/display-format";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DateInput
} from "@polaris/ui";

/** `2026-09-08`, as a date input wants it. */
function toDateValue(reading: Reading): string {
    return `${reading.year}-${String(reading.month).padStart(2, "0")}-${String(reading.day).padStart(2, "0")}`;
}

/** `09:00`, as a time input wants it. */
function toTimeValue(reading: Reading): string {
    return `${String(reading.hours).padStart(2, "0")}:${String(reading.minutes).padStart(2, "0")}`;
}

/** The reading a pair of fields is showing, or null while one of them is empty
 *  or holds something a calendar does not have. */
function fromFields(date: string, time: string): Reading | null {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const clock = /^(\d{2}):(\d{2})/.exec(time);
    if (!day || !clock) return null;
    return {
        year: Number(day[1]),
        month: Number(day[2]),
        day: Number(day[3]),
        hours: Number(clock[1]),
        minutes: Number(clock[2])
    };
}

export function ScheduleDialog({
    open,
    onOpenChange,
    onConfirm,
    busy = false,
    error,
    words,
    presets = true
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The instant chosen, as an ISO string. The composer owns what is being
     *  sent; this only says when. */
    onConfirm: (sendAt: string) => void;
    busy?: boolean;
    /** What the server said, when it refused one this dialog thought was fine. */
    error?: string;
    /** The dialog's own copy, for a caller choosing a time for something other
     *  than sending - a reminder. Left out, it reads as scheduling a message. */
    words?: {
        readonly title: string;
        readonly description: string;
        readonly confirm: string;
        readonly busy: string;
        readonly summary: (date: string, time: string) => string;
    };
    /** The three quick answers above the fields. Off where the caller already
     *  offered its own, so the same choice is not asked twice. */
    presets?: boolean;
}) {
    const t = useTranslations("chat");
    const format = useDisplayFormat();
    const { timeZone } = useDisplayPreferences();

    /** Now, as the account's own clock reads it. Everything below is built from
     *  this rather than from the browser's own day. */
    const today = useMemo(() => core.wallClock(new Date(), timeZone), [timeZone, open]);

    const tomorrowMorning = useMemo(
        () => plusDays({ ...today, hours: MORNING, minutes: 0 }, 1),
        [today]
    );
    /** The next Monday that is not today. */
    const mondayMorning = useMemo(() => {
        const ahead = (8 - weekdayOf(today)) % 7 || 7;
        return plusDays({ ...today, hours: MORNING, minutes: 0 }, ahead);
    }, [today]);

    const [date, setDate] = useState(() => toDateValue(tomorrowMorning));
    const [time, setTime] = useState(() => toTimeValue(tomorrowMorning));

    const reading = fromFields(date, time);
    const at = reading ? core.zonedInstant(reading, timeZone) : null;
    const problem = at ? core.scheduleProblem(at) : "noDate";
    const refusal = problem ? t(`errors.schedule.${problem}`) : null;

    /** A press that answers the question outright, since a preset is an answer
     *  rather than a starting point for the fields below it. */
    const take = (moment: Date) => onConfirm(moment.toISOString());

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{words?.title ?? t("schedule.sendThisLater")}</DialogTitle>
                    <DialogDescription>
                        {words?.description ?? t("schedule.itStaysOutOfThe")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    {presets && (
                        <div className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                onClick={() => take(new Date(Date.now() + 30 * 60 * 1000))}
                            >
                                {t("schedule.in30Minutes")}
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                onClick={() => take(core.zonedInstant(tomorrowMorning, timeZone))}
                            >
                                {t("schedule.tomorrowAt", {
                                    time: format.time(core.zonedInstant(tomorrowMorning, timeZone))
                                })}
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                onClick={() => take(core.zonedInstant(mondayMorning, timeZone))}
                            >
                                {t("schedule.mondayAt", {
                                    time: format.time(core.zonedInstant(mondayMorning, timeZone))
                                })}
                            </Button>
                        </div>
                    )}

                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("schedule.date")}
                            <DateInput
                                mode="date"
                                value={date}
                                aria-label={t("schedule.date")}
                                onChange={(event) => setDate(event.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("schedule.time")}
                            <DateInput
                                mode="time"
                                value={time}
                                aria-label={t("schedule.time")}
                                onChange={(event) => setTime(event.target.value)}
                            />
                        </label>
                        <Button
                            className="ml-auto"
                            disabled={busy || refusal !== null}
                            onClick={() => at && take(at)}
                        >
                            <CalendarClock className="size-4" />
                            {busy
                                ? (words?.busy ?? t("schedule.scheduling"))
                                : (words?.confirm ?? t("schedule.schedule"))}
                        </Button>
                    </div>

                    <p
                        className={
                            refusal || error
                                ? "text-xs text-danger"
                                : "text-xs text-muted-foreground"
                        }
                    >
                        {error ??
                            refusal ??
                            (at
                                ? words
                                    ? words.summary(format.date(at), format.time(at))
                                    : t("schedule.sendsOn", {
                                          date: format.date(at),
                                          time: format.time(at)
                                      })
                                : "")}
                        {!refusal && !error && timeZone !== core.AUTOMATIC_TIME_ZONE
                            ? ` ${timeZone.replace(/_/g, " ")}.`
                            : ""}
                    </p>
                </div>

                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                        {t("schedule.cancel")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
