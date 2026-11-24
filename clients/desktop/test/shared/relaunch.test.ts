/**
 * A call is carried across a restart the app made, for the page's own window
 * and no longer, to the page of the server it was on, once.
 */

import { describe, expect, it } from "vitest";
import { CALL_NOTE_MAX, RELAUNCH_WINDOW_MS, heldCalls, readCallNote, readRelaunch, readRelaunchMark, relaunchFor } from "@/shared/relaunch";

const HERE = "https://polaris.example.test";
const THERE = "https://other.example.test";
const mark = { reason: "update" as const, at: 1_000, calls: [{ origin: HERE, note: "here" }, { origin: THERE, note: "there" }] };

describe("a restart the app made", () => {
    it("hands each server's page its own call, once", () => {
        const first = relaunchFor(mark, HERE, 2_000);
        expect(first.answer).toEqual({ reason: "update", at: 1_000, call: "here" });
        const again = relaunchFor(first.rest, HERE, 3_000);
        expect(again.answer).toEqual({ reason: "update", at: 1_000, call: null });
        expect(relaunchFor(again.rest, THERE, 4_000).answer).toEqual({ reason: "update", at: 1_000, call: "there" });
    });

    it("counts within its window and not after it, nor for a clock that went backwards", () => {
        expect(relaunchFor(mark, HERE, 1_000 + RELAUNCH_WINDOW_MS).answer?.call).toBe("here");
        expect(relaunchFor(mark, HERE, 1_001 + RELAUNCH_WINDOW_MS)).toEqual({ answer: null, rest: null });
        expect(relaunchFor(mark, HERE, 999)).toEqual({ answer: null, rest: null });
    });

    it("is nothing when nothing was written down: a person opening the app", () => {
        expect(relaunchFor(null, HERE, 2_000)).toEqual({ answer: null, rest: null });
    });

    it("reads nothing else as a restart", () => {
        expect(readRelaunchMark({ reason: "crash", at: 1, calls: [] })).toBeNull();
        expect(readRelaunchMark({ reason: "update", at: -1, calls: [] })).toBeNull();
        expect(readRelaunchMark({ ...mark, extra: true })).toBeNull();
        expect(readRelaunchMark(mark)).toEqual(mark);
        expect(readRelaunch({ reason: "update", at: 1, call: null })).toEqual({ reason: "update", at: 1, call: null });
        expect(readRelaunch({ reason: "update", at: 1 })).toBeNull();
        expect(readRelaunch("update")).toBeNull();
    });

    it("keeps a page's note only while it is one", () => {
        expect(readCallNote(null)).toBeNull();
        expect(readCallNote("{}")).toBe("{}");
        expect(readCallNote("")).toBeUndefined();
        expect(readCallNote("x".repeat(CALL_NOTE_MAX + 1))).toBeUndefined();
        expect(readCallNote({ session: {} })).toBeUndefined();
    });

    it("writes down the newest few calls", () => {
        const many = Array.from({ length: 12 }, (_, index) => ({ origin: HERE, note: String(index) }));
        expect(heldCalls(many).map((call) => call.note)).toEqual(["4", "5", "6", "7", "8", "9", "10", "11"]);
    });
});
