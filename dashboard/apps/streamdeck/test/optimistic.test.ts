/**
 * A press shows its result at once: the guess, what replaces it, what puts the
 * key back, a dial's turns gathered into one command, and a press that is
 * already done sending nothing.
 */

import { faceFor } from "../src/face";
import { wordsFor } from "../src/words";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAlso, DialBurst, InFlight, predict, shows } from "../src/optimistic";
import { PolarisClient, readLocked, TimedOut, type DeckState } from "../src/polaris";

const toggle = { kind: "toggle" as const };
const run = { kind: "run" as const };

describe("predict", () => {
    it("flips a toggle Polaris said nothing about", () => {
        expect(predict(toggle, { tone: "ok", on: true })).toEqual({
            face: { tone: "ok", on: false }
        });
    });

    it("shows the face Polaris said a press shows", () => {
        const locking: DeckState = { tone: "warn", on: true, icon: "lock", detail: "Locking" };
        expect(
            predict(run, { tone: "warn", detail: "Unlocked", press: { face: locking } })
        ).toEqual({ face: locking });
    });

    it("says a press that is already done is one", () => {
        expect(predict(run, { tone: "ok", detail: "Locked", press: { noop: true } })).toEqual({
            noop: true
        });
    });

    it("waits for the answer when it cannot know", () => {
        expect(predict(run, { tone: "idle" })).toBeNull();
        expect(predict(toggle, undefined)).toBeNull();
        expect(predict(undefined, { tone: "ok", on: true })).toBeNull();
    });
});

describe("InFlight", () => {
    const before: DeckState = { tone: "ok", on: true };

    it("puts the face back when the press is refused or unanswered", () => {
        const flight = new InFlight();
        flight.begin("k", before);
        expect(flight.busy("k")).toBe(true);
        expect(flight.settle("k", false)).toEqual(before);
        expect(flight.busy("k")).toBe(false);
    });

    it("settles on the state Polaris returned", () => {
        const flight = new InFlight();
        flight.begin("k", before);
        expect(flight.settle("k", true, { tone: "idle", on: false })).toEqual({
            tone: "idle",
            on: false
        });
    });

    it("holds a reading that arrives mid-press and settles on it", () => {
        const flight = new InFlight();
        expect(flight.hold("k", before)).toBe(false);
        flight.begin("k", before);
        expect(flight.hold("k", { tone: "idle", on: false })).toBe(true);
        expect(flight.settle("k", true)).toEqual({ tone: "idle", on: false });
    });

    it("keeps the guess when the press worked and nothing newer came", () => {
        const flight = new InFlight();
        flight.begin("k", before);
        expect(flight.settle("k", true)).toBeUndefined();
    });
});

describe("a press that moves other keys", () => {
    const muted: DeckState = { tone: "warn", on: true, icon: "mic-off" };
    const heard: DeckState = { tone: "idle", on: false, icon: "mic" };
    const deafened: DeckState = { tone: "warn", on: true, icon: "headphone-off" };
    const deafen: DeckState = {
        tone: "idle",
        on: false,
        icon: "headphones",
        press: { face: deafened, also: [{ action: "call.mic", face: muted }] }
    };
    /** Two keys on the deck: deafen (pressed) and the microphone. */
    const keys: Record<string, string> = { d: "call.deafen", m: "call.mic" };
    const keysOf = (also: { action: string }) =>
        Object.keys(keys).filter((key) => keys[key] === also.action);

    it("carries what Polaris said a press does to other keys", () => {
        expect(predict(toggle, deafen)).toEqual({
            face: deafened,
            also: [{ action: "call.mic", face: muted }]
        });
    });

    it("draws deafening's mute on the microphone's key at once", () => {
        const flight = new InFlight();
        flight.begin("d", deafen);
        const states: Record<string, DeckState> = { d: deafen, m: heard };
        const drawn = beginAlso(flight, deafen.press!.also, keysOf, (key) => states[key]);
        expect(drawn).toEqual([{ key: "m", state: muted }]);
        expect(flight.busy("m")).toBe(true);
        // A reading from before the press does not flick it back meanwhile.
        expect(flight.hold("m", heard)).toBe(true);
    });

    it("puts the microphone back when the deafen is refused or unanswered", () => {
        const flight = new InFlight();
        flight.begin("d", deafen);
        beginAlso(flight, deafen.press!.also, keysOf, () => heard);
        expect(flight.settle("d", false)).toEqual(deafen);
        expect(flight.settle("m", false)).toEqual(heard);
        expect(flight.busy("m")).toBe(false);
    });

    it("keeps the guess when the press worked, until the stream says otherwise", () => {
        const flight = new InFlight();
        flight.begin("d", deafen);
        beginAlso(flight, deafen.press!.also, keysOf, () => heard);
        expect(flight.settle("m", true)).toBeUndefined();
        flight.begin("d", deafen);
        beginAlso(flight, deafen.press!.also, keysOf, () => heard);
        flight.hold("m", muted);
        expect(flight.settle("m", true)).toEqual(muted);
    });

    it("leaves alone a key with its own press on the way, or nothing to put back", () => {
        const flight = new InFlight();
        flight.begin("m", heard);
        expect(beginAlso(flight, deafen.press!.also, keysOf, () => heard)).toEqual([]);
        expect(beginAlso(new InFlight(), deafen.press!.also, keysOf, () => undefined)).toEqual([]);
    });

    it("names keys by action, and by settings when it gives them", () => {
        const away = { action: "status.presence", options: { choice: "away" }, face: heard };
        expect(shows(away, "status.presence", { choice: "away" })).toBe(true);
        expect(shows(away, "status.presence", { choice: "busy" })).toBe(false);
        expect(shows(away, "status.presence", {})).toBe(false);
        expect(shows(away, "call.mic", { choice: "away" })).toBe(false);
        expect(shows({ action: "call.mic", face: muted }, "call.mic", {})).toBe(true);
    });
});

describe("DialBurst", () => {
    afterEach(() => vi.useRealTimers());

    it("gathers a burst of ticks into one landing, from where it began", () => {
        vi.useFakeTimers();
        const landed: [string, number][] = [];
        const burst = new DialBurst(350, (id, from) => landed.push([id, from]));
        burst.turn("d", 20);
        vi.advanceTimersByTime(200);
        burst.turn("d", 20.5);
        vi.advanceTimersByTime(200);
        burst.turn("d", 21);
        expect(burst.turning("d")).toBe(true);
        expect(landed).toEqual([]);
        vi.advanceTimersByTime(400);
        expect(landed).toEqual([["d", 20]]);
        expect(burst.turning("d")).toBe(false);
    });

    it("forgets a dial that went away", () => {
        vi.useFakeTimers();
        const landed: string[] = [];
        const burst = new DialBurst(350, (id) => landed.push(id));
        burst.turn("d", 1);
        burst.forget("d");
        vi.advanceTimersByTime(1000);
        expect(landed).toEqual([]);
    });
});

describe("a deck missing a permission", () => {
    const words = wordsFor("es");

    it("draws Reconnect on a key set to an action it lost", () => {
        expect(
            faceFor("online", { action: "places.door" }, undefined, undefined, words, true)
        ).toEqual({ icon: "lock", tone: "bad", label: "Reconectar" });
        expect(
            faceFor("online", { action: "places.door" }, undefined, undefined, words).label
        ).toBe(words.pick);
    });

    it("keeps only well-formed rows of what reconnecting allows", () => {
        expect(
            readLocked([
                { id: "places.door", label: "Door", message: "Reconnect this deck to allow: X." },
                { id: 3 },
                null
            ])
        ).toEqual([
            { id: "places.door", label: "Door", message: "Reconnect this deck to allow: X." }
        ]);
        expect(readLocked(undefined)).toEqual([]);
    });
});

describe("a press Polaris does not answer", () => {
    it("is reported as timed out, not as Polaris being gone", async () => {
        const fetcher = vi.fn(async () => {
            throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        });
        const client = new PolarisClient("0.1.6", fetcher as never);
        await expect(
            client.run(
                { address: "https://polaris.test", token: "t", keyId: "k", account: "a" },
                "places.door",
                {}
            )
        ).rejects.toBeInstanceOf(TimedOut);
        const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });
});
