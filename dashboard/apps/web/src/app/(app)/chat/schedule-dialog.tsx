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
import { useMemo, useState } from "react";
import { CalendarClock } from "lucide-react";
import { useDisplayFormat, useDisplayPreferences } from "@/components/display-format";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/** The hour "morning" means. Nine, which is what every client that offers this
 *  settled on and what an office day starts at. */
const MORNING = 9;

interface Reading {
    year: number;
    month: number;
    day: number;
    hours: number;
    minutes: number;
}

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

/** The day after this one, in the zone the reading is written in. Built through
 *  UTC so the month and the year roll over on their own rather than here. */
function plusDays(reading: Reading, days: number): Reading {
    const walked = new Date(Date.UTC(reading.year, reading.month - 1, reading.day + days));
    return {
        year: walked.getUTCFullYear(),
        month: walked.getUTCMonth() + 1,
        day: walked.getUTCDate(),
        hours: reading.hours,
        minutes: reading.minutes
    };
}

/** Which day of the week a reading falls on, 0 for Sunday. */
function weekdayOf(reading: Reading): number {
    return new Date(Date.UTC(reading.year, reading.month - 1, reading.day)).getUTCDay();
}

export function ScheduleDialog({
    open,
    onOpenChange,
    onConfirm,
    busy = false,
    error
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The instant chosen, as an ISO string. The composer owns what is being
     *  sent; this only says when. */
    onConfirm: (sendAt: string) => void;
    busy?: boolean;
    /** What the server said, when it refused one this dialog thought was fine. */
    error?: string;
}) {
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
    const refusal = at ? core.scheduleRefusal(at) : "Pick a date and a time";

    /** A press that answers the question outright, since a preset is an answer
     *  rather than a starting point for the fields below it. */
    const take = (moment: Date) => onConfirm(moment.toISOString());

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Send this later</DialogTitle>
                    <DialogDescription>
                        It stays out of the conversation until then. Nobody is told, and you can take
                        it back at any point before it goes.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => take(new Date(Date.now() + 30 * 60 * 1000))}
                        >
                            In 30 minutes
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => take(core.zonedInstant(tomorrowMorning, timeZone))}
                        >
                            Tomorrow at {format.time(core.zonedInstant(tomorrowMorning, timeZone))}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => take(core.zonedInstant(mondayMorning, timeZone))}
                        >
                            Monday at {format.time(core.zonedInstant(mondayMorning, timeZone))}
                        </Button>
                    </div>

                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-sm">
                            Date
                            <input
                                type="date"
                                value={date}
                                aria-label="Date"
                                onChange={(event) => setDate(event.target.value)}
                                className="rounded-md border border-border bg-field px-2 py-1.5 text-sm text-foreground hover:border-border-strong focus:border-border-strong"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Time
                            <input
                                type="time"
                                value={time}
                                aria-label="Time"
                                onChange={(event) => setTime(event.target.value)}
                                className="rounded-md border border-border bg-field px-2 py-1.5 text-sm text-foreground hover:border-border-strong focus:border-border-strong"
                            />
                        </label>
                        <Button
                            className="ml-auto"
                            disabled={busy || refusal !== null}
                            onClick={() => at && take(at)}
                        >
                            <CalendarClock className="size-4" />
                            {busy ? "Scheduling..." : "Schedule"}
                        </Button>
                    </div>

                    <p className={refusal || error ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
                        {error ??
                            refusal ??
                            (at ? `Sends on ${format.date(at)} at ${format.time(at)}.` : "")}
                        {!refusal && !error && timeZone !== core.AUTOMATIC_TIME_ZONE
                            ? ` ${timeZone.replace(/_/g, " ")}.`
                            : ""}
                    </p>
                </div>

                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
