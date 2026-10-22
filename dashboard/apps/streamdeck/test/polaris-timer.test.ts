/**
 * A timer kept in Polaris: old timer keys stay on the deck, presses map to
 * Calendar's operations, the key counts with the server's clock, and a press
 * shows its result before Polaris answers and goes back when refused.
 */

import { InFlight } from "../src/optimistic";
import { describe, expect, it } from "vitest";
import * as remote from "../src/polaris-timer";
import type { DeckState } from "../src/polaris";

const running = (endsAt: number, serverNow: number): DeckState => ({
    tone: "ok",
    on: true,
    value: "5:00",
    countdown: {
        state: "running",
        remainingMs: endsAt - serverNow,
        durationMs: 300_000,
        endsAt,
        serverNow
    }
});

describe("settings", () => {
    it("keeps every timer key set before on the deck", () => {
        expect(remote.sourceOf({})).toBe("deck");
        expect(remote.sourceOf({ mode: "countdown", minutes: 5 } as never)).toBe("deck");
        expect(remote.sourceOf(null)).toBe("deck");
        expect(remote.sourceOf({ source: "polaris" })).toBe("polaris");
    });

    it("runs a Polaris key as Calendar's timer, a new one by default", () => {
        expect(remote.polarisOptions({ source: "polaris" })).toEqual({
            timer: "new",
            name: "",
            minutes: 5
        });
        expect(remote.polarisOptions({ polarisTimer: "focus", minutes: 9000 })).toMatchObject({
            timer: "focus",
            minutes: 1440
        });
    });
});

describe("presses", () => {
    it("start or pause, add a minute or skip a phase, and reset", () => {
        expect(remote.opFor("press", "new")).toBe("toggle");
        expect(remote.opFor("double", "abc")).toBe("add");
        expect(remote.opFor("double", "focus")).toBe("skip");
        expect(remote.opFor("hold", "focus")).toBe("reset");
    });
});

describe("the time on the key", () => {
    it("counts with Polaris's clock, however far the deck's own is off", () => {
        // Polaris is 7 s ahead of the deck: read at the deck's 1000, its 8000.
        const state = running(8000 + 60_000, 8000);
        const skew = remote.skewOf(state.countdown, 1000);
        expect(skew).toBe(7000);
        expect(remote.remainingAt(state.countdown!, 1000, skew)).toBe(60_000);
        expect(remote.timeText(remote.remainingAt(state.countdown!, 31_000, skew))).toBe("0:30");
        expect(remote.finishedAt(state.countdown!, 60_999, skew)).toBe(false);
        expect(remote.finishedAt(state.countdown!, 61_000, skew)).toBe(true);
    });

    it("holds a stopped timer and draws an hour as hours", () => {
        const countdown = {
            state: "paused" as const,
            remainingMs: 3_723_000,
            durationMs: 3_723_000
        };
        expect(remote.remainingAt(countdown, 99_999_999, 0)).toBe(3_723_000);
        expect(remote.timeText(3_723_000)).toBe("1:02:03");
        expect(remote.timeText(59_001)).toBe("1:00");
    });
});

describe("a press before Polaris answers", () => {
    it("pauses a running timer where it is, and starts a paused one from there", () => {
        const paused = remote.predictTimer(running(70_000, 10_000), "toggle", 20_000, 0)!;
        expect(paused.countdown).toEqual({
            state: "paused",
            remainingMs: 50_000,
            durationMs: 300_000
        });
        expect(paused).toMatchObject({ tone: "idle", on: false, value: "0:50" });
        const again = remote.predictTimer(paused, "toggle", 30_000, 2000)!;
        expect(again.countdown).toMatchObject({
            state: "running",
            endsAt: 82_000,
            serverNow: 32_000
        });
    });

    it("adds and turns minutes, resets, and waits on a phase to skip", () => {
        const state = running(70_000, 10_000);
        expect(remote.predictTimer(state, "add", 10_000, 0)!.countdown?.endsAt).toBe(130_000);
        expect(remote.predictTimer(state, "shift", 10_000, 0, -5)!.countdown?.endsAt).toBe(11_000);
        expect(remote.predictTimer(state, "reset", 10_000, 0)!.countdown).toEqual({
            state: "idle",
            remainingMs: 300_000,
            durationMs: 300_000
        });
        expect(remote.predictTimer(state, "skip", 10_000, 0)).toBeNull();
        expect(remote.predictTimer({ tone: "idle" }, "toggle", 0, 0)).toBeNull();
    });

    it("goes back to the face it had when Polaris refuses", () => {
        const before = running(70_000, 10_000);
        const flight = new InFlight();
        flight.begin("k", before);
        const guess = remote.predictTimer(before, "toggle", 20_000, 0)!;
        expect(guess.on).toBe(false);
        expect(flight.settle("k", false)).toBe(before);
    });
});
