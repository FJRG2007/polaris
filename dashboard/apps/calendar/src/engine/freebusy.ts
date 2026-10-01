/**
 * Free/busy: which stretches of time an occurrence list makes busy, and the
 * times when everybody asked is free.
 *
 * Free time (TRANSP:TRANSPARENT), cancelled occurrences and invitations the
 * person turned down do not block anything. A tentative event blocks as
 * BUSY-TENTATIVE and an out-of-office block as BUSY-UNAVAILABLE, the RFC 5545
 * FBTYPE values a CalDAV free/busy answer uses.
 */

import type { BusyInterval, Occurrence } from "./types";
import { instantAt, localDays, minutesOf, weekdayIndex } from "./hours";

/** One stretch of a working day, local time. `to` may be "24:00". */
export interface HoursRange {
    readonly from: string;
    readonly to: string;
}

/** Working hours per weekday, "0" = Sunday .. "6" = Saturday. A day with no
 *  ranges is not a working day. */
export type WorkingHours = Readonly<
    Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", readonly HoursRange[]>
>;

const RANK: Readonly<Record<BusyInterval["type"], number>> = {
    "BUSY-TENTATIVE": 0,
    BUSY: 1,
    "BUSY-UNAVAILABLE": 2
};
const BY_RANK: readonly BusyInterval["type"][] = ["BUSY-TENTATIVE", "BUSY", "BUSY-UNAVAILABLE"];

/** The busy intervals a list of occurrences makes, unmerged. */
export function busyFromOccurrences(
    occurrences: readonly Occurrence[],
    options: { selfEmail?: string } = {}
): BusyInterval[] {
    const self = options.selfEmail?.trim().toLowerCase();
    const busy: BusyInterval[] = [];
    for (const occurrence of occurrences) {
        const event = occurrence.event;
        if (event.transparency === "TRANSPARENT" || event.status === "CANCELLED") continue;
        if (
            self &&
            event.attendees.some(
                (attendee) => attendee.email === self && attendee.partstat === "DECLINED"
            )
        )
            continue;
        if (occurrence.end.getTime() <= occurrence.start.getTime()) continue;
        const type: BusyInterval["type"] =
            event.kind === "outOfOffice"
                ? "BUSY-UNAVAILABLE"
                : event.status === "TENTATIVE"
                  ? "BUSY-TENTATIVE"
                  : "BUSY";
        busy.push({ start: occurrence.start, end: occurrence.end, type });
    }
    return busy;
}

/**
 * Overlapping and touching intervals joined, sorted by start. Where intervals
 * of different kinds overlap, the stronger kind wins for the overlap
 * (unavailable over busy over tentative), so the result never double-counts
 * and never hides that somebody is away.
 */
export function mergeBusy(intervals: readonly BusyInterval[]): BusyInterval[] {
    const changes = new Map<number, number[]>();
    for (const interval of intervals) {
        const start = interval.start.getTime();
        const end = interval.end.getTime();
        if (!(end > start)) continue;
        const rank = RANK[interval.type];
        for (const [at, delta] of [
            [start, 1],
            [end, -1]
        ] as const) {
            const counts = changes.get(at) ?? [0, 0, 0];
            counts[rank] = (counts[rank] ?? 0) + delta;
            changes.set(at, counts);
        }
    }
    const points = [...changes.keys()].sort((a, b) => a - b);
    const active = [0, 0, 0];
    const pieces: BusyInterval[] = [];
    for (let index = 0; index + 1 < points.length; index++) {
        const from = points[index] ?? 0;
        const to = points[index + 1] ?? 0;
        const counts = changes.get(from) ?? [];
        for (let rank = 0; rank < active.length; rank++)
            active[rank] = (active[rank] ?? 0) + (counts[rank] ?? 0);
        let type: BusyInterval["type"] | null = null;
        for (let rank = active.length - 1; rank >= 0 && type === null; rank--)
            if ((active[rank] ?? 0) > 0) type = BY_RANK[rank] ?? null;
        if (!type) continue;
        const last = pieces[pieces.length - 1];
        if (last && last.type === type && last.end.getTime() === from)
            pieces[pieces.length - 1] = { ...last, end: new Date(to) };
        else pieces.push({ start: new Date(from), end: new Date(to), type });
    }
    return pieces;
}

function overlapsAny(start: number, end: number, busy: readonly BusyInterval[]): boolean {
    return busy.some(
        (interval) => interval.start.getTime() < end && interval.end.getTime() > start
    );
}

/** The local-day windows a day offers: its working hours, or the whole day. */
export function windowsFor(date: string, workingHours: WorkingHours | null): HoursRange[] {
    if (!workingHours) return [{ from: "00:00", to: "24:00" }];
    const key = String(weekdayIndex(date)) as keyof WorkingHours;
    return [...(workingHours[key] ?? [])];
}

/**
 * Times, `durationMinutes` long, when nobody in `busy` (one list per person)
 * is busy: inside working hours in `zone` when given, not before `now`, on
 * steps of `stepMinutes` from the start of each window, at most `limit`.
 */
export function suggestTimes(input: {
    busy: readonly (readonly BusyInterval[])[];
    durationMinutes: number;
    from: Date;
    to: Date;
    zone: string;
    workingHours: WorkingHours | null;
    stepMinutes: number;
    limit: number;
    now: Date;
}): { start: Date; end: Date }[] {
    const everyone = mergeBusy(input.busy.flat());
    const step = Math.max(1, Math.floor(input.stepMinutes));
    const earliest = Math.max(input.from.getTime(), input.now.getTime());
    const found: { start: Date; end: Date }[] = [];
    for (const date of localDays(input.from, input.to, input.zone)) {
        for (const window of windowsFor(date, input.workingHours)) {
            const open = minutesOf(window.from);
            const close = minutesOf(window.to);
            for (let minute = open; minute + input.durationMinutes <= close; minute += step) {
                const start = instantAt(date, minute, input.zone).getTime();
                const end = start + input.durationMinutes * 60_000;
                if (start < earliest || end > input.to.getTime() || end <= start) continue;
                if (overlapsAny(start, end, everyone)) continue;
                if (found.some((slot) => slot.start.getTime() === start)) continue;
                found.push({ start: new Date(start), end: new Date(end) });
                if (found.length >= input.limit) return found;
            }
        }
    }
    return found;
}
