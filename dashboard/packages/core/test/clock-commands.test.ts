import { describe, expect, it } from "vitest";
import { CLOCK_TIMER_MAX_MS, parseClockCommand } from "../src/clock-commands.js";

const MIN = 60_000;

describe("parseClockCommand", () => {
    it("reads a timer in every way people write a length", () => {
        expect(parseClockCommand("timer 10m")).toEqual({
            kind: "timer",
            durationMs: 10 * MIN,
            label: ""
        });
        expect(parseClockCommand("timer 10 min")).toMatchObject({ durationMs: 10 * MIN });
        expect(parseClockCommand("timer 1h30m")).toMatchObject({ durationMs: 90 * MIN });
        expect(parseClockCommand("timer 1h 30m")).toMatchObject({ durationMs: 90 * MIN });
        expect(parseClockCommand("timer 90s")).toMatchObject({ durationMs: 90_000 });
        expect(parseClockCommand("timer 1.5h")).toMatchObject({ durationMs: 90 * MIN });
        expect(parseClockCommand("timer 5:00")).toMatchObject({ durationMs: 5 * MIN });
        expect(parseClockCommand("timer 1:02:03")).toMatchObject({ durationMs: 3_723_000 });
        expect(parseClockCommand("timer 10")).toMatchObject({ durationMs: 10 * MIN });
        expect(parseClockCommand("  /Timer 25 minutes  ")).toMatchObject({ durationMs: 25 * MIN });
    });

    it("keeps what follows the length as the label", () => {
        expect(parseClockCommand("timer 4m tea")).toEqual({
            kind: "timer",
            durationMs: 4 * MIN,
            label: "tea"
        });
        expect(parseClockCommand("timer 10 pasta   water")).toMatchObject({
            durationMs: 10 * MIN,
            label: "pasta water"
        });
        expect(parseClockCommand("temporizador 5 min huevos")).toMatchObject({
            durationMs: 5 * MIN,
            label: "huevos"
        });
    });

    it("refuses a timer it cannot read or could not show", () => {
        expect(parseClockCommand("timer")).toBeNull();
        expect(parseClockCommand("timer tea")).toBeNull();
        expect(parseClockCommand("timer 0s")).toBeNull();
        expect(parseClockCommand("timer 1h 30")).toBeNull();
        expect(parseClockCommand("timer 100h")).toBeNull();
        expect(parseClockCommand("timer 99h59m59s")).toMatchObject({
            durationMs: CLOCK_TIMER_MAX_MS
        });
    });

    it("reads an alarm in 24-hour and 12-hour clocks", () => {
        expect(parseClockCommand("alarm 7:30")).toEqual({
            kind: "alarm",
            hour: 7,
            minute: 30,
            label: ""
        });
        expect(parseClockCommand("alarm 19:05 gym")).toEqual({
            kind: "alarm",
            hour: 19,
            minute: 5,
            label: "gym"
        });
        expect(parseClockCommand("alarm 7pm")).toMatchObject({ hour: 19, minute: 0 });
        expect(parseClockCommand("alarm 12am")).toMatchObject({ hour: 0, minute: 0 });
        expect(parseClockCommand("alarm 12:15 p.m.")).toMatchObject({ hour: 12, minute: 15 });
        expect(parseClockCommand("alarma 7.30 despertar")).toMatchObject({
            hour: 7,
            minute: 30,
            label: "despertar"
        });
    });

    it("refuses an alarm that is not a time of day", () => {
        expect(parseClockCommand("alarm 7")).toBeNull();
        expect(parseClockCommand("alarm 24:00")).toBeNull();
        expect(parseClockCommand("alarm 7:60")).toBeNull();
        expect(parseClockCommand("alarm 13pm")).toBeNull();
        expect(parseClockCommand("alarm soon")).toBeNull();
    });

    it("starts the stopwatch by its name alone", () => {
        expect(parseClockCommand("stopwatch")).toEqual({ kind: "stopwatch" });
        expect(parseClockCommand("Cronómetro")).toEqual({ kind: "stopwatch" });
        expect(parseClockCommand("stopwatch now")).toBeNull();
    });

    it("leaves everything else to the search", () => {
        expect(parseClockCommand("")).toBeNull();
        expect(parseClockCommand("timers")).toBeNull();
        expect(parseClockCommand("deploy 10m")).toBeNull();
    });
});
