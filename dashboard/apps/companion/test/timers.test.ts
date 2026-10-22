/**
 * Timer buttons: kept on this machine unless set otherwise, the same timer for
 * every button set to it, Polaris timers counted down with Polaris's clock, and
 * the variables and colours a button reads.
 */

import * as timers from "../src/timers";
import * as mapping from "../src/mapping";
import { describe, expect, it } from "vitest";
import * as local from "../../streamdeck/src/timer";
import { InFlight } from "../../streamdeck/src/optimistic";
import { predictTimer } from "../../streamdeck/src/polaris-timer";
import type { DeckAction, DeckState } from "../../streamdeck/src/polaris";

const TIMER: DeckAction = {
    id: "calendar.timer",
    kind: "toggle",
    area: "tools",
    label: "Calendar timer",
    icon: "timer",
    live: true,
    options: [
        {
            name: "timer",
            type: "choice",
            label: "Timer",
            required: true,
            choices: [
                { value: "new", label: "A new timer" },
                { value: "focus", label: "Focus cycle" },
                { value: "t1", label: "Tea" }
            ]
        },
        { name: "name", type: "text", label: "New timer's name", required: false },
        { name: "minutes", type: "number", label: "Minutes", required: false, min: 1, max: 5999 }
    ]
};

const T0 = Date.UTC(2026, 9, 22, 18, 0, 0);

describe("which timer a button is set to", () => {
    it("is one on this machine when nothing says otherwise", () => {
        expect(timers.refOf({})).toEqual({ source: "deck", timer: "", name: "Timer", minutes: 5 });
        expect(timers.refOf({ source: "elsewhere", minutes: 9 }).source).toBe("deck");
    });

    it("reads a Polaris timer, with a new one found by its name", () => {
        expect(timers.refOf({ source: "polaris", timer: "t1", minutes: 3 })).toEqual({
            source: "polaris",
            timer: "t1",
            name: "",
            minutes: 3
        });
        expect(timers.refOf({ source: "polaris", name: " Tea " })).toMatchObject({
            timer: "new",
            name: "Tea"
        });
    });

    it("shares one timer between buttons set to the same one, whatever its length", () => {
        const a = timers.refOf({ name: "Tea", minutes: 3 });
        const b = timers.refOf({ name: "tea", minutes: 7 });
        expect(timers.identity(a)).toBe(timers.identity(b));
        const polaris = timers.refOf({ source: "polaris", name: "Tea" });
        expect(timers.identity(a)).not.toBe(timers.identity(polaris));
    });

    it("is read under a short stream key that does not change", () => {
        const ref = timers.refOf({ source: "polaris", name: "x".repeat(200) });
        expect(timers.streamKey(ref)).toBe(timers.streamKey({ ...ref }));
        expect(timers.streamKey(ref).length).toBeLessThanOrEqual(64);
        expect(timers.streamKey(ref)).toMatch(/^timer:/);
    });

    it("is run with the catalogue entry's own options and the press", () => {
        const ref = timers.refOf({ source: "polaris", timer: "focus", minutes: 25 });
        expect(timers.deckOptions(ref, "skip")).toEqual({
            timer: "focus",
            name: "",
            minutes: 25,
            op: "skip"
        });
        expect(timers.opOf({ op: "add" })).toBe("add");
        expect(timers.opOf({ op: "explode" })).toBe("toggle");
    });
});

describe("variables", () => {
    it("are named after the timer", () => {
        expect(timers.variablePrefix(timers.refOf({ name: "Té verde" }))).toBe("local_timer_te_verde");
        expect(timers.variablePrefix(timers.refOf({ source: "polaris", timer: "focus" }))).toBe(
            "timer_focus"
        );
        expect(timers.variablePrefix(timers.refOf({ source: "polaris", name: "Tea" }))).toBe("timer_tea");
        expect(timers.variablePrefix(timers.refOf({ source: "polaris", timer: "t1" }), "Pasta 2")).toBe(
            "timer_pasta_2"
        );
        expect(timers.variableDefinitions("timer_tea", "Tea").map((row) => row.id)).toEqual([
            "timer_tea_remaining",
            "timer_tea_state",
            "timer_tea_name"
        ]);
    });

    it("carry the time left, the state and the name", () => {
        const view: timers.TimerView = { status: "running", remaining: "4:59", name: "Tea" };
        expect(timers.variableValues("timer_tea", view)).toEqual({
            timer_tea_remaining: "4:59",
            timer_tea_state: "running",
            timer_tea_name: "Tea"
        });
    });
});

describe("a timer kept on this machine", () => {
    const fresh = local.newTimer("countdown", 5 * 60_000);

    it("is idle, running, paused and done in turn", () => {
        expect(timers.localView(fresh, "Tea", T0)).toEqual({
            status: "idle",
            remaining: "5:00",
            name: "Tea"
        });
        const running = timers.applyLocal(fresh, "toggle", T0);
        expect(timers.localView(running, "Tea", T0 + 1_000).status).toBe("running");
        expect(timers.localView(running, "Tea", T0 + 1_000).remaining).toBe("4:59");
        const paused = timers.applyLocal(running, "toggle", T0 + 60_000);
        expect(timers.localView(paused, "Tea", T0 + 120_000)).toMatchObject({
            status: "paused",
            remaining: "4:00"
        });
        expect(timers.localView(running, "Tea", T0 + 5 * 60_000)).toMatchObject({
            status: "done",
            remaining: "0:00"
        });
    });

    it("takes a minute more, and one that ran out counts down a minute again", () => {
        const running = timers.applyLocal(fresh, "toggle", T0);
        const more = timers.applyLocal(running, "add", T0 + 1_000);
        expect(timers.localView(more, "", T0 + 1_000).remaining).toBe("5:59");
        const rung = timers.applyLocal(running, "add", T0 + 10 * 60_000);
        expect(timers.localView(rung, "", T0 + 10 * 60_000)).toMatchObject({
            status: "running",
            remaining: "1:00"
        });
        // A reset still goes back to its whole length.
        expect(timers.localView(timers.applyLocal(rung, "reset", T0), "", T0).remaining).toBe("5:00");
    });

    it("has no phase to skip, and takes a new length only while stopped", () => {
        expect(timers.applyLocal(fresh, "skip", T0)).toBe(fresh);
        expect(timers.withLength(fresh, 10, T0).durationMs).toBe(10 * 60_000);
        const running = timers.applyLocal(fresh, "toggle", T0);
        expect(timers.withLength(running, 10, T0 + 1_000)).toBe(running);
    });
});

describe("a timer kept in Polaris", () => {
    // Polaris's clock is 3 s ahead of this machine's.
    const skewed: DeckState = {
        tone: "ok",
        detail: "Tea",
        countdown: {
            state: "running",
            remainingMs: 60_000,
            durationMs: 5 * 60_000,
            endsAt: T0 + 3_000 + 60_000,
            serverNow: T0 + 3_000
        }
    };

    it("counts down with Polaris's clock, to the same second", () => {
        expect(timers.polarisView(skewed, T0, "fallback", T0 + 30_000)).toEqual({
            status: "running",
            remaining: "0:30",
            name: "Tea"
        });
        expect(timers.polarisView(skewed, T0, "fallback", T0 + 60_000).status).toBe("done");
    });

    it("is unavailable until Polaris has said, and names what it said", () => {
        expect(timers.polarisView(undefined, T0, "Tea", T0)).toEqual({
            status: "unavailable",
            remaining: "",
            name: "Tea"
        });
        expect(timers.polarisView({ tone: "bad", detail: "Not found" }, T0, "Tea", T0).name).toBe(
            "Not found"
        );
    });

    it("shows a paused or rung one as Polaris has it", () => {
        const paused: DeckState = {
            tone: "idle",
            detail: "Tea",
            countdown: { state: "paused", remainingMs: 61_000, durationMs: 300_000 }
        };
        expect(timers.polarisView(paused, T0, "x", T0 + 99_000)).toMatchObject({
            status: "paused",
            remaining: "1:01"
        });
        const rung: DeckState = {
            tone: "bad",
            detail: "Done",
            countdown: { state: "rung", remainingMs: 0, durationMs: 300_000 }
        };
        expect(timers.polarisView(rung, T0, "Tea", T0)).toEqual({
            status: "done",
            remaining: "0:00",
            name: "Tea"
        });
    });

    it("shows a press at once and goes back when Polaris refuses it", () => {
        const flight = new InFlight();
        const guess = predictTimer(skewed, "toggle", T0 + 30_000, 3_000);
        expect(guess?.countdown).toMatchObject({ state: "paused", remainingMs: 30_000 });
        flight.begin("timer:a", skewed);
        expect(flight.settle("timer:a", false, undefined)).toBe(skewed);
        // A reading that came in meanwhile is newer than the face it had.
        const newer: DeckState = { ...skewed, detail: "Tea (newer)" };
        flight.begin("timer:a", skewed);
        expect(flight.hold("timer:a", newer)).toBe(true);
        expect(flight.settle("timer:a", false, undefined)).toBe(newer);
    });
});

describe("timer buttons", () => {
    it("offer Polaris only to an account with Calendar's timers", () => {
        const sources = (entry?: DeckAction) =>
            (timers.timerOptions(entry, true)[0] as { choices: { id: string }[] }).choices.map(
                (choice) => choice.id
            );
        expect(sources()).toEqual(["deck"]);
        expect(sources(TIMER)).toEqual(["deck", "polaris"]);
        expect(timers.timerOptions(TIMER, true).map((field) => field.id)).toEqual([
            "source",
            "timer",
            "name",
            "minutes",
            "op"
        ]);
        expect(timers.timerOptions(TIMER, false).some((field) => field.id === "op")).toBe(false);
    });

    it("pick from the timers the catalogue listed", () => {
        expect(timers.timerChoices(TIMER).map((choice) => choice.id)).toEqual(["new", "focus", "t1"]);
        expect(timers.timerChoices(undefined)).toEqual([{ id: "new", label: "A new timer" }]);
    });

    it("are coloured by where the timer is, with its name and time", () => {
        expect(timers.timerStyle({ status: "running", remaining: "1:00", name: "Tea" }, true)).toEqual({
            bgcolor: mapping.COLORS.ok,
            color: mapping.COLORS.white,
            text: "Tea\n1:00"
        });
        expect(timers.timerStyle({ status: "done", remaining: "0:00", name: "" }, false)).toEqual({
            bgcolor: mapping.COLORS.bad,
            color: mapping.COLORS.white
        });
    });

    it("replace the catalogue's own timer entry, and come as presets", () => {
        expect(mapping.runnable([TIMER])).toEqual([]);
        expect(mapping.watchable([TIMER])).toEqual([]);
        expect(mapping.presetSpecs([TIMER])).toEqual([]);
        expect(timers.timerPresets(false).map((preset) => preset.id)).toEqual(["timer_local"]);
        expect(timers.timerPresets(true).map((preset) => preset.id)).toEqual(["timer_local", "timer_focus"]);
    });
});
