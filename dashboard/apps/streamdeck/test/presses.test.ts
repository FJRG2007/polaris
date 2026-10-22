/**
 * Press, double press, hold, alternating and confirmed keys, timed with fake
 * timers: what fires, when, and that a plain press adds no wait.
 */

import { wordsFor } from "../src/words";
import type { DeckAction } from "../src/polaris";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alternates, bindingFor, faceFor, gesturesOf, turnLevel } from "../src/face";
import { CONFIRM_MS, Confirmations, PressTimer, windowMs, type Gesture } from "../src/presses";

const plain = { double: false, hold: false, doubleMs: 300, holdMs: 500 };

function timer() {
    const fired: Gesture[] = [];
    const presses = new PressTimer((_key, gesture) => fired.push(gesture));
    return { fired, presses };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PressTimer", () => {
    it("fires a plain press on key down, with no wait", () => {
        const { fired, presses } = timer();
        presses.down("k", plain);
        expect(fired).toEqual(["press"]);
        presses.up("k");
        vi.advanceTimersByTime(1000);
        expect(fired).toEqual(["press"]);
    });

    it("waits the double window after a press, then fires it once", () => {
        const { fired, presses } = timer();
        const set = { ...plain, double: true };
        presses.down("k", set);
        presses.up("k");
        vi.advanceTimersByTime(299);
        expect(fired).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(fired).toEqual(["press"]);
    });

    it("fires a double press on the second key down, and no press after it", () => {
        const { fired, presses } = timer();
        const set = { ...plain, double: true };
        presses.down("k", set);
        presses.up("k");
        vi.advanceTimersByTime(200);
        presses.down("k", set);
        expect(fired).toEqual(["double"]);
        presses.up("k");
        vi.advanceTimersByTime(1000);
        expect(fired).toEqual(["double"]);
    });

    it("fires a hold while still held, and nothing on letting go", () => {
        const { fired, presses } = timer();
        const set = { ...plain, hold: true };
        presses.down("k", set);
        vi.advanceTimersByTime(499);
        expect(fired).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(fired).toEqual(["hold"]);
        presses.up("k");
        vi.advanceTimersByTime(1000);
        expect(fired).toEqual(["hold"]);
    });

    it("counts a short press on a key with a hold as a press, on key up", () => {
        const { fired, presses } = timer();
        presses.down("k", { ...plain, hold: true });
        vi.advanceTimersByTime(100);
        presses.up("k");
        expect(fired).toEqual(["press"]);
    });

    it("tells all three apart on one key with its own windows", () => {
        const { fired, presses } = timer();
        const set = { double: true, hold: true, doubleMs: 400, holdMs: 800 };
        presses.down("k", set);
        vi.advanceTimersByTime(800);
        presses.up("k");
        presses.down("k", set);
        presses.up("k");
        vi.advanceTimersByTime(399);
        presses.down("k", set);
        presses.up("k");
        presses.down("k", set);
        presses.up("k");
        vi.advanceTimersByTime(400);
        expect(fired).toEqual(["hold", "double", "press"]);
    });

    it("keeps keys apart and forgets one that left the screen", () => {
        const { fired, presses } = timer();
        const set = { ...plain, double: true };
        presses.down("a", set);
        presses.up("a");
        presses.down("b", set);
        presses.up("b");
        presses.forget("a");
        vi.advanceTimersByTime(300);
        expect(fired).toEqual(["press"]);
    });

    it("holds a window between its limits", () => {
        expect(windowMs(undefined, 300)).toBe(300);
        expect(windowMs(10, 300)).toBe(150);
        expect(windowMs(99_999, 300)).toBe(2000);
        expect(windowMs(420.4, 300)).toBe(420);
    });
});

describe("Confirmations", () => {
    it("arms on the first press and runs on a second within the wait", () => {
        const confirm = new Confirmations();
        expect(confirm.press("k", 0)).toBe(false);
        expect(confirm.armed("k", 1000)).toBe(true);
        expect(confirm.press("k", 1000)).toBe(true);
        // Run, it is disarmed: the next press only arms it again.
        expect(confirm.press("k", 1100)).toBe(false);
    });

    it("lets the wait run out", () => {
        const confirm = new Confirmations();
        confirm.press("k", 0);
        expect(confirm.armed("k", CONFIRM_MS + 1)).toBe(false);
        expect(confirm.press("k", CONFIRM_MS + 1)).toBe(false);
    });
});

const words = wordsFor("en");

function entry(kind: DeckAction["kind"], id = "places.device-command"): DeckAction {
    return { id, kind, area: "places", label: "Fan", icon: "fan", options: [], live: false };
}

describe("gestures in a key's settings", () => {
    it("reads the windows and which gestures are set", () => {
        expect(gesturesOf({ action: "a" })).toEqual(plain);
        expect(
            gesturesOf({ action: "a", double: { action: "b" }, hold: { action: "c" }, holdMs: 900 })
        ).toEqual({ double: true, hold: true, doubleMs: 300, holdMs: 900 });
    });

    it("runs another entry for a double press or a hold, the key's own for a press", () => {
        const settings = { action: "a", double: { action: "b" }, hold: { action: "c" } };
        expect(bindingFor(settings, entry("run"), "press")).toBeNull();
        expect(bindingFor(settings, entry("run"), "double")?.action).toBe("b");
        expect(bindingFor(settings, entry("run"), "hold")?.action).toBe("c");
    });

    it("alternates between two actions and shows which ran last", () => {
        const settings = { action: "on", alternate: { action: "off" } };
        expect(alternates(settings, entry("run"))).toBe(true);
        expect(bindingFor(settings, entry("run"), "press")).toBeNull();
        expect(bindingFor({ ...settings, side: "b" }, entry("run"), "press")?.action).toBe("off");
        expect(faceFor("online", settings, entry("run"), undefined, words)).toMatchObject({
            on: false,
            tone: "idle"
        });
        expect(
            faceFor("online", { ...settings, side: "b" }, entry("run"), undefined, words)
        ).toMatchObject({ on: true, tone: "ok" });
    });

    it("never alternates a real toggle: the key follows what Polaris reads", () => {
        const settings = { action: "t", alternate: { action: "off" }, side: "b" as const };
        expect(alternates(settings, entry("toggle"))).toBe(false);
        expect(bindingFor(settings, entry("toggle"), "press")).toBeNull();
        expect(
            faceFor("online", settings, entry("toggle"), { tone: "idle", on: false }, words)
        ).toMatchObject({ on: false });
    });
});

describe("turnLevel with a range Polaris sent", () => {
    it("turns a temperature half a degree a tick, inside its range", () => {
        const range = { min: 16, max: 30, step: 0.5 };
        expect(turnLevel(undefined, 0, range)).toBe(23);
        expect(turnLevel(22, 3, range)).toBe(23.5);
        expect(turnLevel(29.5, 5, range)).toBe(30);
        expect(turnLevel(16, -2, range)).toBe(16);
    });
});
