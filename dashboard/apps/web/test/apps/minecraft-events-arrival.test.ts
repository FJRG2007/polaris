/**
 * The wait every event that takes its players somewhere has before it starts
 * (`arrival`): who is in, for how long it waits, and the countdown.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as arrival from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arrival";

afterEach(() => {
    arrival.forget("run");
    vi.useRealTimers();
});

describe("waiting for everybody to arrive", () => {
    it("starts once everybody has been seen in place, counting whoever was seen before", () => {
        arrival.open("run", 1_000);
        let first = arrival.look("run", 1_000, ["Ana", "Ben"], (name) => name === "Ana");
        expect(first).toMatchObject({ arrived: 1, total: 2, missing: ["Ben"], start: false });
        // Ana has since stepped off: seen once is enough.
        first = arrival.look("run", 3_000, ["Ana", "Ben"], (name) => name === "ben");
        expect(first.start).toBe(false);
        const all = arrival.look("run", 3_000, ["Ana", "Ben"], (name) => name === "Ben");
        expect(all).toMatchObject({ arrived: 2, missing: [], start: true });
        expect(arrival.hasArrived("run", "ana")).toBe(true);
    });

    it("starts anyway once the wait runs out, with who is still missing", () => {
        arrival.open("run", 0);
        expect(arrival.look("run", arrival.ARRIVAL_MS - 1, ["Ana", "Ben"], () => false).start).toBe(
            false
        );
        const late = arrival.look("run", arrival.ARRIVAL_MS, ["Ana", "Ben"], (name) => name === "Ana");
        expect(late).toMatchObject({ start: true, missing: ["Ben"] });
        const said = arrival.startedWithoutLines(late, "en");
        expect(said).toHaveLength(1);
        expect(said[0]).toContain("Ben");
        expect(arrival.startedWithoutLines({ ...late, missing: [] }, "en")).toEqual([]);
    });

    it("waits afresh after a restart lost the wait", () => {
        expect(arrival.isOpen("run")).toBe(false);
        const look = arrival.look("run", 50_000, ["Ana"], () => false);
        expect(look.start).toBe(false);
        expect(arrival.isOpen("run")).toBe(true);
    });

    it("shows how many are in, in each reader's language", () => {
        arrival.open("run", 0);
        const look = arrival.look("run", 0, ["Ana", "Ben", "Cy"], (name) => name === "Cy");
        expect(arrival.waitingLine("@a[tag=pe_in]", look, "en")).toContain("Waiting for everybody");
        expect(arrival.waitingLine("@a[tag=pe_in]", look, "en")).toContain("1/3");
        expect(arrival.waitingLine("@a[tag=pe_in]", look, "es")).toContain("Esperando a todos");
    });

    it("counts down 3, 2, 1 a second apart, then hands back for the Go", async () => {
        vi.useFakeTimers();
        const sent: string[][] = [];
        const done = arrival.countdown(
            async (lines) => {
                sent.push(lines);
            },
            "@a[tag=pe_in]",
            "en"
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sent).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(2_000);
        await done;
        expect(sent).toHaveLength(3);
        const numbers = sent.map((lines) => lines.find((line) => /^title \S+ title /.test(line)));
        expect(numbers[0]).toContain("3");
        expect(numbers[1]).toContain("2");
        expect(numbers[2]).toContain("1");
    });
});
