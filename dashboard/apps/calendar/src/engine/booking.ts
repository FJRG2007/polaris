/**
 * Booking pages: the slots a visitor may pick.
 *
 * Availability is weekly hours plus per-date overrides in the page's own time
 * zone (an override of `[]` closes that day). A slot must start after the
 * minimum notice and within the horizon, both counted from now; with its
 * buffers around it, it must not touch a busy time, and it keeps the larger
 * buffer clear on both sides of another booking, whose own buffers count; and a
 * day that already has `maxPerDay` bookings offers nothing. Slots start every
 * `slotMinutes` from the start of each availability window, computed on the
 * zone's wall clock so a clock change moves no slot off its hour.
 */

import type { BusyInterval } from "./types";
import type { HoursRange, WorkingHours } from "./freebusy";
import { instantAt, localDate, localDays, minutesOf, weekdayIndex } from "./hours";

/** When a booking page takes bookings. */
export interface Availability {
    readonly weekly: WorkingHours;
    /** Per local date, replacing that weekday's hours; `[]` = closed. */
    readonly overrides: Readonly<Record<string, readonly HoursRange[]>>;
}

/** Everything `bookingSlots` needs. Minutes throughout. */
export interface BookingInput {
    readonly durationMinutes: number;
    readonly slotMinutes: number;
    readonly bufferBefore: number;
    readonly bufferAfter: number;
    readonly noticeMinutes: number;
    readonly maxPerDay: number | null;
    readonly horizonDays: number;
    readonly timezone: string;
    readonly availability: Availability;
    readonly busy: readonly BusyInterval[];
    readonly bookings: readonly { readonly start: Date; readonly end: Date }[];
    readonly now: Date;
    readonly from: Date;
    readonly to: Date;
}

const MINUTE = 60_000;

/** The slots a booking page offers between `from` and `to`, in order. */
export function bookingSlots(input: BookingInput): { start: Date; end: Date }[] {
    const earliest = Math.max(
        input.from.getTime(),
        input.now.getTime() + input.noticeMinutes * MINUTE
    );
    const latest = Math.min(
        input.to.getTime(),
        input.now.getTime() + input.horizonDays * 86_400_000
    );
    if (latest <= earliest || input.durationMinutes <= 0) return [];
    const step = Math.max(1, Math.floor(input.slotMinutes || input.durationMinutes));
    const perDay = new Map<string, number>();
    for (const booking of input.bookings) {
        const day = localDate(booking.start, input.timezone);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    const spacing = Math.max(input.bufferBefore, input.bufferAfter) * MINUTE;
    const found: { start: Date; end: Date }[] = [];
    for (const date of localDays(new Date(earliest), new Date(latest), input.timezone)) {
        if (input.maxPerDay !== null && (perDay.get(date) ?? 0) >= input.maxPerDay) continue;
        const key = String(weekdayIndex(date)) as keyof WorkingHours;
        const windows = input.availability.overrides[date] ?? input.availability.weekly[key] ?? [];
        for (const window of windows) {
            const open = minutesOf(window.from);
            const close = minutesOf(window.to);
            for (let minute = open; minute + input.durationMinutes <= close; minute += step) {
                const start = instantAt(date, minute, input.timezone).getTime();
                const end = start + input.durationMinutes * MINUTE;
                if (start < earliest || start >= latest || end <= start) continue;
                const guardFrom = start - input.bufferBefore * MINUTE;
                const guardTo = end + input.bufferAfter * MINUTE;
                if (
                    input.busy.some(
                        (interval) =>
                            interval.start.getTime() < guardTo && interval.end.getTime() > guardFrom
                    )
                )
                    continue;
                if (
                    input.bookings.some(
                        (booking) =>
                            booking.start.getTime() - spacing < end &&
                            booking.end.getTime() + spacing > start
                    )
                )
                    continue;
                if (found.some((slot) => slot.start.getTime() === start)) continue;
                found.push({ start: new Date(start), end: new Date(end) });
            }
        }
    }
    return found.sort((a, b) => a.start.getTime() - b.start.getTime());
}
