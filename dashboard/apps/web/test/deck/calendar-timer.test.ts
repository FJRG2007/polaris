/**
 * Calendar's timers on a deck: which timer a key means, what a press sends,
 * and what the key counts down from.
 */

import { describe, expect, it } from "vitest";

const timers = await import("@polaris-app/calendar/src/lib/deck-actions");

const action = timers.calendarDeckActions()[0]!;
const TEA = "55555555-5555-4555-8555-555555555555";
const FOCUS = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-10-22T10:00:00.000Z";

const row = (overrides: Record<string, unknown> = {}) => ({
    id: TEA,
    label: "Tea",
    state: "running",
    endsAt: "2026-10-22T10:04:00.000Z",
    focus: null,
    durationMs: 5 * 60_000,
    remainingMs: 4 * 60_000,
    ...overrides
});
const list = (...rows: Record<string, unknown>[]) => ({ timers: rows, serverNow: NOW });

describe("the catalogue entry", () => {
    it("is a live key bound to the clock tools, under the permission to change timers", () => {
        expect(action).toMatchObject({
            id: "calendar.timer",
            kind: "toggle",
            scope: "calendar.manage"
        });
        expect(action.read?.tool).toBe("clock_list");
        expect(action.fields[0]?.fixed?.map((choice) => choice.value)).toEqual(["new", "focus"]);
        expect(action.fields[0]?.choices?.pick(list(row(), row({ id: FOCUS, label: "" })))).toEqual(
            [
                { value: TEA, label: "Tea" },
                { value: FOCUS, label: "05:00" }
            ]
        );
    });

    it("needs a name for a new timer, which is how it is found again", () => {
        expect(action.options.safeParse({ timer: "new" }).success).toBe(false);
        expect(action.options.safeParse({ timer: "new", name: "Tea" }).success).toBe(true);
        expect(action.options.safeParse({ timer: TEA, op: "explode" }).success).toBe(false);
    });
});

describe("a press", () => {
    const press = (options: Record<string, unknown>, read: unknown, step?: number) => ({
        tool: (action.run.tool as (o: unknown, p: unknown) => string)(options, { read, step }),
        input: action.run.input(options, { read, step })
    });

    it("pauses a running timer and resumes a stopped one", () => {
        expect(press({ timer: TEA }, list(row()))).toEqual({
            tool: "clock_timer_change",
            input: { timer: TEA, action: "pause" }
        });
        expect(press({ timer: TEA }, list(row({ state: "paused", endsAt: null }))).input).toEqual({
            timer: TEA,
            action: "resume"
        });
    });

    it("creates a new timer on its first press, and works it by its name after", () => {
        const options = { timer: "new", name: "Tea", minutes: 3 };
        expect(press(options, list())).toEqual({
            tool: "clock_timer_start",
            input: { minutes: 3, label: "Tea" }
        });
        expect(press(options, list(row()))).toEqual({
            tool: "clock_timer_change",
            input: { timer: TEA, action: "pause" }
        });
        // Only a start creates one: a reset of a timer not made yet does nothing.
        expect(press({ ...options, op: "reset" }, list()).input).toBeNull();
    });

    it("starts the focus cycle when there is none, and skips its phase when there is", () => {
        expect(press({ timer: "focus" }, list()).tool).toBe("clock_focus_start");
        const cycle = list(row({ id: FOCUS, focus: "focus" }));
        expect(press({ timer: "focus", op: "skip" }, cycle).input).toEqual({
            timer: FOCUS,
            action: "skip"
        });
        expect(press({ timer: TEA, op: "skip" }, list(row())).input).toBeNull();
    });

    it("resets, adds a minute, and turns a dial by its ticks", () => {
        expect(press({ timer: TEA, op: "reset" }, list(row())).input).toEqual({
            timer: TEA,
            action: "reset"
        });
        expect(press({ timer: TEA, op: "add" }, list(row())).input).toEqual({
            timer: TEA,
            action: "add_minute"
        });
        expect(press({ timer: TEA, op: "shift" }, list(row()), -3).input).toEqual({
            timer: TEA,
            action: "shift",
            minutes: -3
        });
    });

    it("sends nothing for a timer that was deleted", () => {
        expect(press({ timer: FOCUS }, list(row())).input).toBeNull();
    });
});

describe("what the key shows", () => {
    it("counts down from when it ends on the server's clock, while it runs", () => {
        expect(action.read!.pick(list(row()), "en-US", { timer: TEA })).toEqual({
            tone: "ok",
            icon: "timer",
            on: true,
            value: "4:00",
            detail: "Tea",
            countdown: {
                state: "running",
                remainingMs: 240_000,
                durationMs: 300_000,
                endsAt: Date.parse("2026-10-22T10:04:00.000Z"),
                serverNow: Date.parse(NOW)
            }
        });
    });

    it("carries no clock while stopped, so a stopped key is not redrawn", () => {
        const state = action.read!.pick(
            list(row({ state: "paused", endsAt: null, remainingMs: 61_500 })),
            "es-ES",
            { timer: TEA }
        );
        expect(state).toMatchObject({ tone: "idle", icon: "pause", value: "1:02" });
        expect(state.countdown).toEqual({
            state: "paused",
            remainingMs: 61_500,
            durationMs: 300_000
        });
    });

    it("says it is done, a focus phase by name, and a deleted timer, in the reader's words", () => {
        const rung = list(row({ state: "rung", endsAt: null, remainingMs: 0 }));
        expect(action.read!.pick(rung, "es-ES", { timer: TEA })).toMatchObject({
            tone: "bad",
            detail: "Hecho",
            value: "0:00"
        });
        const cycle = list(row({ focus: "short" }));
        expect(action.read!.pick(cycle, "es-ES", { timer: "focus" }).detail).toBe("Pausa");
        expect(action.read!.pick(list(), "en-US", { timer: TEA })).toEqual({
            tone: "bad",
            icon: "timer",
            detail: "Not found"
        });
    });

    it("shows a new timer at its length before it exists", () => {
        expect(
            action.read!.pick(list(), "en-US", { timer: "new", name: "Tea", minutes: 3 })
        ).toMatchObject({
            tone: "idle",
            value: "3:00",
            detail: "Tea"
        });
    });

    it("says a new timer with no name needs one", () => {
        expect(action.read!.pick(list(), "en-US", { timer: "new", name: "  " })).toEqual({
            tone: "bad",
            icon: "timer",
            detail: "Needs a name"
        });
        expect(action.read!.pick(list(), "es-ES", { timer: "new" }).detail).toBe("Sin nombre");
        expect(action.read!.pick(list(), "en-US", { timer: "" })).toEqual({ tone: "idle" });
    });

    it("tells the plugin what a start or pause shows at once", () => {
        const state = action.read!.pick(list(row()), "en-US", { timer: TEA });
        const press = action.read!.press!(state, { timer: TEA }, list(row()), "en-US");
        expect(press?.face).toMatchObject({ tone: "idle", on: false, value: "4:00" });
        expect(press?.face?.countdown).toEqual({
            state: "paused",
            remainingMs: 240_000,
            durationMs: 300_000
        });
        expect(
            action.read!.press!(state, { timer: TEA, op: "reset" }, null, "en-US")
        ).toBeUndefined();
    });
});
