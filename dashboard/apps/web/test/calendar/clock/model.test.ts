/**
 * The Time area's rules as plain values: when an alarm rings next - across both
 * clock changes, in zones either side of UTC - where a focus cycle goes after
 * each phase, and how timers and the stopwatch read.
 */

import { describe, expect, it } from "vitest";
import * as model from "@polaris-app/calendar/src/lib/clock/model";

const MADRID = "Europe/Madrid";
const NEW_YORK = "America/New_York";

const fire = (time: string, days: number, zone: string, after: string) =>
    model.nextAlarmFire({ time, days, zone }, new Date(after)).toISOString();

describe("nextAlarmFire", () => {
    it("rings a one-off later today, or tomorrow once today's time has passed", () => {
        // 09:00 Madrid is 07:00 UTC in summer.
        expect(fire("07:30", 0, MADRID, "2026-07-01T04:00:00Z")).toBe("2026-07-01T05:30:00.000Z");
        expect(fire("07:30", 0, MADRID, "2026-07-01T06:00:00Z")).toBe("2026-07-02T05:30:00.000Z");
    });

    it("never rings at the very instant it was asked from", () => {
        expect(fire("07:30", 0, MADRID, "2026-07-01T05:30:00Z")).toBe("2026-07-02T05:30:00.000Z");
    });

    it("rings only on the weekdays it repeats on", () => {
        // 2026-07-03 is a Friday; weekdays only skips to Monday the 6th.
        expect(fire("07:00", model.WEEKDAYS, MADRID, "2026-07-03T06:00:00Z")).toBe("2026-07-06T05:00:00.000Z");
        // Weekend alarm asked on a Monday rings on Saturday.
        expect(fire("10:00", model.WEEKEND, MADRID, "2026-07-06T06:00:00Z")).toBe("2026-07-11T08:00:00.000Z");
    });

    it("waits a whole week for a weekly alarm whose only day is today, already past", () => {
        // Wednesday 2026-07-01 at 08:00 Madrid, after its 07:00 ring.
        const wednesday = 1 << 3;
        expect(fire("07:00", wednesday, MADRID, "2026-07-01T06:00:00Z")).toBe("2026-07-08T05:00:00.000Z");
    });

    it("reads the wall time in the alarm's zone, whichever side of UTC", () => {
        expect(fire("07:00", 0, NEW_YORK, "2026-07-01T00:00:00Z")).toBe("2026-07-01T11:00:00.000Z");
        expect(fire("07:00", 0, "Asia/Tokyo", "2026-07-01T00:00:00Z")).toBe("2026-07-01T22:00:00.000Z");
        expect(fire("07:00", 0, "Asia/Kolkata", "2026-07-01T00:00:00Z")).toBe("2026-07-01T01:30:00.000Z");
    });

    it("keeps the wall time across the spring change", () => {
        // Madrid moves from +01 to +02 at 01:00 UTC on Sunday 29 March 2026.
        expect(fire("07:00", model.EVERY_DAY, MADRID, "2026-03-28T07:00:00Z")).toBe("2026-03-29T05:00:00.000Z");
        expect(fire("07:00", model.EVERY_DAY, MADRID, "2026-03-27T07:00:00Z")).toBe("2026-03-28T06:00:00.000Z");
    });

    it("rings a time the spring change skips an hour later, as RFC 5545 reads it", () => {
        // 02:30 does not exist in Madrid on 29 March 2026: it is 03:30 CEST, 01:30 UTC.
        expect(fire("02:30", 0, MADRID, "2026-03-28T23:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
    });

    it("rings a time the autumn change repeats once, the first time", () => {
        // 02:30 happens twice in Madrid on 25 October 2026: 00:30 UTC (CEST), then 01:30 UTC (CET).
        expect(fire("02:30", 0, MADRID, "2026-10-24T22:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
        // And the next day it is back to one reading, on the new offset.
        expect(fire("02:30", model.EVERY_DAY, MADRID, "2026-10-25T00:30:00Z")).toBe("2026-10-26T01:30:00.000Z");
    });

    it("keeps the wall time across New York's changes too", () => {
        // EDT -> EST on 1 November 2026: 07:00 is 11:00 UTC, then 12:00 UTC.
        expect(fire("07:00", model.EVERY_DAY, NEW_YORK, "2026-10-31T12:00:00Z")).toBe("2026-11-01T12:00:00.000Z");
        expect(fire("07:00", model.EVERY_DAY, NEW_YORK, "2026-10-30T12:00:00Z")).toBe("2026-10-31T11:00:00.000Z");
    });
});

describe("focus cycles", () => {
    const config = { focus: 25, short: 5, long: 15, rounds: 3, auto: true };

    it("runs focus, short break, focus... and a long break after the last round", () => {
        let state = model.startPomodoro(config);
        const seen: string[] = [`${state.phase}${state.round}`];
        for (let step = 0; step < 7; step++) {
            state = model.nextPhase(state);
            seen.push(`${state.phase}${state.round}`);
        }
        expect(seen).toEqual(["focus1", "short1", "focus2", "short2", "focus3", "long3", "focus1", "short1"]);
        expect(state.done).toBe(4);
    });

    it("counts each phase by its own length", () => {
        const state = model.startPomodoro(config);
        expect(model.phaseMs(state, "focus")).toBe(25 * 60_000);
        expect(model.phaseMs(state, "short")).toBe(5 * 60_000);
        expect(model.phaseMs(state, "long")).toBe(15 * 60_000);
    });

    it("reads a stored cycle, and nothing that is not one", () => {
        const state = model.startPomodoro(config);
        expect(model.readPomodoro(JSON.stringify(state))).toEqual(state);
        expect(model.readPomodoro(null)).toBeNull();
        expect(model.readPomodoro("not json")).toBeNull();
        expect(model.readPomodoro(JSON.stringify({ ...state, rounds: 99 }))).toBeNull();
    });

    it("refuses lengths outside what the settings allow", () => {
        expect(model.pomodoroConfigSchema.safeParse({ ...config, focus: 0 }).success).toBe(false);
        expect(model.pomodoroConfigSchema.safeParse({ ...config, rounds: 1 }).success).toBe(false);
        expect(model.pomodoroConfigSchema.safeParse(config).success).toBe(true);
    });
});

describe("timers and the stopwatch", () => {
    const base = { durationMs: 60_000, endsAt: null, remainingMs: null, firedAt: null };

    it("tells the four states apart and what is left in each", () => {
        const now = Date.parse("2026-07-01T10:00:00Z");
        expect(model.timerState(base)).toBe("idle");
        expect(model.timerRemaining(base, now)).toBe(60_000);
        const running = { ...base, endsAt: "2026-07-01T10:00:20Z" };
        expect(model.timerState(running)).toBe("running");
        expect(model.timerRemaining(running, now)).toBe(20_000);
        expect(model.timerRemaining(running, now + 60_000)).toBe(0);
        const paused = { ...base, remainingMs: 12_000 };
        expect(model.timerState(paused)).toBe("paused");
        expect(model.timerRemaining(paused, now)).toBe(12_000);
        const rung = { ...base, firedAt: "2026-07-01T09:59:00Z" };
        expect(model.timerState(rung)).toBe("rung");
        expect(model.timerRemaining(rung, now)).toBe(0);
    });

    it("counts the stopwatch from what it held and when it started", () => {
        const now = Date.parse("2026-07-01T10:00:10Z");
        expect(model.stopwatchElapsed({ startedAt: null, elapsedMs: 5000 }, now)).toBe(5000);
        expect(model.stopwatchElapsed({ startedAt: "2026-07-01T10:00:00Z", elapsedMs: 5000 }, now)).toBe(15_000);
    });

    it("splits laps from their running totals", () => {
        expect(model.lapSplits([1000, 2500, 4000])).toEqual([1000, 1500, 1500]);
        expect(model.readLaps("[1000, -1, \"x\", 2000]")).toEqual([1000, 2000]);
        expect(model.readLaps("broken")).toEqual([]);
    });

    it("reads a timer face the way clocks do", () => {
        expect(model.formatClockMs(3_723_456, { hundredths: true })).toBe("1:02:03.45");
        expect(model.formatClockMs(83_000)).toBe("01:23");
        // A countdown shows 00:01 until it really is zero.
        expect(model.formatCountdown(200)).toBe("00:01");
        expect(model.formatCountdown(0)).toBe("00:00");
    });

    it("validates what a screen sends for an alarm and a timer", () => {
        const alarm = { time: "07:30", days: 0, label: "  Wake  up ", sound: "bell", snoozeMinutes: 10, enabled: true };
        const parsed = model.alarmInputSchema.safeParse(alarm);
        expect(parsed.success && parsed.data.label).toBe("Wake up");
        expect(model.alarmInputSchema.safeParse({ ...alarm, time: "24:00" }).success).toBe(false);
        expect(model.alarmInputSchema.safeParse({ ...alarm, days: 128 }).success).toBe(false);
        expect(model.alarmInputSchema.safeParse({ ...alarm, snoozeMinutes: 7 }).success).toBe(false);
        expect(model.alarmInputSchema.safeParse({ ...alarm, sound: "siren" }).success).toBe(false);
        expect(model.timerInputSchema.safeParse({ label: "", durationMs: 500, sound: "chime", start: true }).success).toBe(false);
        expect(
            model.timerInputSchema.safeParse({ label: "", durationMs: model.CLOCK_TIMER_MAX_MS + 1000, sound: "chime", start: true }).success
        ).toBe(false);
    });
});
