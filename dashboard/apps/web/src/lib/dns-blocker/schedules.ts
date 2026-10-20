/**
 * The operator's schedules, as the engine reads them.
 *
 * The engine judges a schedule by its container's clock, which is UTC and must
 * stay UTC: the query log is written in UTC and read back as UTC, one file per
 * UTC day. So the hours typed on the screen, in the operator's zone, are moved to
 * UTC here, with the zone's offset at `now`. A daylight-saving change moves that
 * offset; the configuration rendered after it no longer matches the one the
 * engine runs, and the `dns-blocker-clock` job applies it again on its own
 * (`clock-change.ts`).
 *
 * Pure, so every shift across midnight and across the week is asserted in a test.
 */

import { DNS_WEEKDAYS, type DnsSchedule } from "./settings";

const DAY = 24 * 60;
const WEEK = 7 * DAY;

/** One schedule in the engine's own shape. */
export interface EngineSchedule {
    weekdays: string[];
    start?: string;
    end?: string;
}

export interface EngineSchedules {
    schedules: Record<string, EngineSchedule>;
    listSchedules: Record<string, string[]>;
}

/** Minutes `zone` is ahead of UTC at `at` (Madrid in summer: 120). UTC for a
 *  zone this runtime does not know, or none. */
export function zoneOffsetMinutes(zone: string, at: Date): number {
    if (!zone) return 0;
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hourCycle: "h23",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric"
        }).formatToParts(at);
    } catch {
        return 0;
    }
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((item) => item.type === type)?.value ?? 0);
    const local = Date.UTC(
        part("year"),
        part("month") - 1,
        part("day"),
        part("hour"),
        part("minute")
    );
    const utc = Math.floor(at.getTime() / 60_000) * 60_000;
    return Math.round((local - utc) / 60_000);
}

function minutes(time: string): number {
    const [hours, mins] = time.split(":");
    return Number(hours) * 60 + Number(mins);
}

function clock(total: number): string {
    const value = ((total % DAY) + DAY) % DAY;
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/** A stretch of the week in UTC, as the engine can write it: a day, and either
 *  the whole of it or a start and an end (an end before the start runs into the
 *  next day). */
interface Piece {
    day: number;
    start: number;
    end: number;
    whole: boolean;
}

/** The pieces one local window on one weekday becomes in UTC. */
function piecesOf(day: number, start: number, length: number, offset: number): Piece[] {
    const from = (((day * DAY + start - offset) % WEEK) + WEEK) % WEEK;
    const utcDay = Math.floor(from / DAY);
    const at = from % DAY;
    if (length < DAY) return [{ day: utcDay, start: at, end: (at + length) % DAY, whole: false }];
    if (at === 0) return [{ day: utcDay, start: 0, end: 0, whole: true }];
    // A whole local day that starts mid-way through a UTC day: the rest of that
    // day (start to midnight), then the next one up to the same time.
    return [
        { day: utcDay, start: at, end: 0, whole: false },
        { day: (utcDay + 1) % 7, start: 0, end: at, whole: false }
    ];
}

/**
 * The engine's `schedules` and `listSchedules`, or null when nothing is
 * scheduled. A schedule naming only lists that do not exist (`existing`) is
 * left out: the engine refuses to start on a schedule for an undefined list.
 */
export function engineSchedules(
    schedules: readonly DnsSchedule[],
    timeZone: string,
    existing: ReadonlySet<string>,
    now: Date
): EngineSchedules | null {
    const offset = zoneOffsetMinutes(timeZone, now);
    const out: EngineSchedules = { schedules: {}, listSchedules: {} };
    schedules.forEach((schedule, index) => {
        const lists = schedule.lists.filter((list) => existing.has(list));
        if (lists.length === 0) return;
        const start = schedule.start ? minutes(schedule.start) : 0;
        const length = schedule.start ? (minutes(schedule.end) - start + DAY) % DAY || DAY : DAY;
        // Pieces with the same hours share one engine schedule, whatever their day.
        const byHours = new Map<string, { piece: Piece; days: Set<number> }>();
        for (const name of schedule.days) {
            for (const piece of piecesOf(DNS_WEEKDAYS.indexOf(name), start, length, offset)) {
                const key = piece.whole ? "whole" : `${piece.start}-${piece.end}`;
                const entry = byHours.get(key) ?? { piece, days: new Set<number>() };
                entry.days.add(piece.day);
                byHours.set(key, entry);
            }
        }
        const names: string[] = [];
        [...byHours.values()].forEach(({ piece, days }, part) => {
            const name = `polaris-${index + 1}-${part + 1}`;
            names.push(name);
            out.schedules[name] = {
                weekdays: DNS_WEEKDAYS.filter((_, day) => days.has(day)),
                ...(piece.whole ? {} : { start: clock(piece.start), end: clock(piece.end) })
            };
        });
        for (const list of lists) (out.listSchedules[list] ??= []).push(...names);
    });
    return Object.keys(out.schedules).length > 0 ? out : null;
}
