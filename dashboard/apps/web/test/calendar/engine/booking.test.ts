/**
 * U14: booking slots - availability and date overrides, buffers, minimum
 * notice, horizon, per-day cap and clock changes.
 */

import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

const ZONE = "Europe/Madrid";

const weekdays = (ranges: engine.HoursRange[]): engine.WorkingHours => ({
    "0": [],
    "1": ranges,
    "2": ranges,
    "3": ranges,
    "4": ranges,
    "5": ranges,
    "6": []
});

function input(change: Partial<engine.BookingInput> = {}): engine.BookingInput {
    return {
        durationMinutes: 30,
        slotMinutes: 30,
        bufferBefore: 0,
        bufferAfter: 0,
        noticeMinutes: 0,
        maxPerDay: null,
        horizonDays: 60,
        timezone: ZONE,
        availability: { weekly: weekdays([{ from: "09:00", to: "11:00" }]), overrides: {} },
        busy: [],
        bookings: [],
        now: new Date("2026-06-01T00:00:00Z"),
        from: new Date("2026-06-01T00:00:00Z"),
        to: new Date("2026-06-02T00:00:00Z"),
        ...change
    };
}

const local = (slots: { start: Date }[]) =>
    slots.map((slot) =>
        engine.formatWall(engine.instantToWall(slot.start, ZONE)).slice(0, 16).replace("2026-", "")
    );

describe("bookingSlots", () => {
    it("offers slots every slotMinutes from each window's start", () => {
        expect(local(engine.bookingSlots(input()))).toEqual([
            "06-01T09:00",
            "06-01T09:30",
            "06-01T10:00",
            "06-01T10:30"
        ]);
        expect(local(engine.bookingSlots(input({ durationMinutes: 45, slotMinutes: 15 })))).toEqual(
            [
                "06-01T09:00",
                "06-01T09:15",
                "06-01T09:30",
                "06-01T09:45",
                "06-01T10:00",
                "06-01T10:15"
            ]
        );
    });

    it("keeps buffers clear around busy time and other bookings", () => {
        const slots = engine.bookingSlots(
            input({
                bufferBefore: 15,
                bufferAfter: 15,
                busy: [
                    {
                        start: new Date("2026-06-01T07:30:00Z"),
                        end: new Date("2026-06-01T08:00:00Z"),
                        type: "BUSY"
                    }
                ]
            })
        );
        // Busy 09:30-10:00 local: 09:00 would end at 09:30 + 15 min buffer; 10:00
        // would start 15 min after it ends.
        expect(local(slots)).toEqual(["06-01T10:30"]);
        const booked = engine.bookingSlots(
            input({
                bookings: [
                    {
                        start: new Date("2026-06-01T07:00:00Z"),
                        end: new Date("2026-06-01T07:30:00Z")
                    }
                ]
            })
        );
        expect(local(booked)).toEqual(["06-01T09:30", "06-01T10:00", "06-01T10:30"]);
    });

    it("keeps the buffers of an existing booking clear on both sides of it", () => {
        // Booked 09:30-10:00 local.
        const bookings = [
            { start: new Date("2026-06-01T07:30:00Z"), end: new Date("2026-06-01T08:00:00Z") }
        ];
        expect(
            local(engine.bookingSlots(input({ bufferAfter: 15, slotMinutes: 15, bookings })))
        ).toEqual(["06-01T10:15", "06-01T10:30"]);
        expect(
            local(engine.bookingSlots(input({ bufferBefore: 15, slotMinutes: 15, bookings })))
        ).toEqual(["06-01T10:15", "06-01T10:30"]);
        // Busy time that is not a booking only keeps the new slot's own buffers.
        const busy: engine.BusyInterval[] = [
            { start: bookings[0]!.start, end: bookings[0]!.end, type: "BUSY" }
        ];
        expect(
            local(engine.bookingSlots(input({ bufferAfter: 15, slotMinutes: 15, busy })))
        ).toEqual(["06-01T10:00", "06-01T10:15", "06-01T10:30"]);
    });

    it("respects the minimum notice and the horizon, both from now", () => {
        const notice = engine.bookingSlots(
            input({ now: new Date("2026-06-01T06:50:00Z"), noticeMinutes: 60 })
        );
        // Now is 08:50 local; an hour's notice leaves 10:00 onwards.
        expect(local(notice)).toEqual(["06-01T10:00", "06-01T10:30"]);
        const horizon = engine.bookingSlots(
            input({ horizonDays: 1, to: new Date("2026-06-10T00:00:00Z") })
        );
        expect(local(horizon)).toEqual([
            "06-01T09:00",
            "06-01T09:30",
            "06-01T10:00",
            "06-01T10:30"
        ]);
    });

    it("stops offering a day that has its maximum of bookings", () => {
        const slots = engine.bookingSlots(
            input({
                maxPerDay: 1,
                to: new Date("2026-06-03T00:00:00Z"),
                bookings: [
                    {
                        start: new Date("2026-06-01T08:00:00Z"),
                        end: new Date("2026-06-01T08:30:00Z")
                    }
                ]
            })
        );
        expect(local(slots)).toEqual(["06-02T09:00", "06-02T09:30", "06-02T10:00", "06-02T10:30"]);
    });

    it("uses a date's override instead of the weekday, and [] closes the day", () => {
        const slots = engine.bookingSlots(
            input({
                to: new Date("2026-06-04T00:00:00Z"),
                availability: {
                    weekly: weekdays([{ from: "09:00", to: "10:00" }]),
                    overrides: { "2026-06-02": [], "2026-06-03": [{ from: "16:00", to: "17:00" }] }
                }
            })
        );
        expect(local(slots)).toEqual(["06-01T09:00", "06-01T09:30", "06-03T16:00", "06-03T16:30"]);
    });

    it("keeps slots on their local hours across a clock change", () => {
        const slots = engine.bookingSlots(
            input({
                now: new Date("2026-03-27T00:00:00Z"),
                from: new Date("2026-03-27T00:00:00Z"),
                to: new Date("2026-03-31T00:00:00Z"),
                slotMinutes: 60,
                durationMinutes: 60,
                availability: {
                    weekly: {
                        ...weekdays([{ from: "09:00", to: "10:00" }]),
                        "0": [{ from: "01:00", to: "04:00" }]
                    },
                    overrides: {}
                }
            })
        );
        expect(slots.map((slot) => slot.start.toISOString())).toEqual([
            "2026-03-27T08:00:00.000Z",
            // Sunday 29 March: 02:00-03:00 does not exist in Madrid.
            "2026-03-29T00:00:00.000Z",
            "2026-03-29T01:00:00.000Z",
            "2026-03-30T07:00:00.000Z"
        ]);
        expect(local(slots)).toEqual(["03-27T09:00", "03-29T01:00", "03-29T03:00", "03-30T09:00"]);
    });

    it("keeps a slot in the repeated hour of a clock change at its length", () => {
        const slots = engine.bookingSlots(
            input({
                availability: {
                    weekly: { ...weekdays([]), "0": [{ from: "02:00", to: "04:00" }] },
                    overrides: {}
                },
                now: new Date("2026-10-24T00:00:00Z"),
                from: new Date("2026-10-24T00:00:00Z"),
                to: new Date("2026-10-26T00:00:00Z")
            })
        );
        expect(slots.length).toBeGreaterThan(0);
        for (const slot of slots)
            expect(slot.end.getTime() - slot.start.getTime()).toBe(30 * 60_000);
    });

    it("offers nothing when the range is over", () => {
        expect(engine.bookingSlots(input({ now: new Date("2026-06-02T00:00:00Z") }))).toEqual([]);
    });
});
