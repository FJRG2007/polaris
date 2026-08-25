/**
 * Ordering a list by what it is using.
 *
 * The case worth pinning is the one that looks like a bug from the outside: a
 * list sorted by CPU that opens with a column of dashes, because "not running"
 * sorted as zero and zero is the lowest number there is.
 */

import { describe, expect, it } from "vitest";
import { sortByConsumption, type ConsumptionRow } from "@/lib/watch/card-order";

function row(name: string, cpuPercent: number | null, memUsedBytes: number | null, state = "running"): ConsumptionRow {
    return { name, cpuPercent, memUsedBytes, state };
}

const ROWS = [
    row("idle", 0.2, 40),
    row("busy", 91, 10),
    row("stopped", null, null, "exited"),
    row("middling", 12, 900)
];

function names(rows: readonly ConsumptionRow[]): string[] {
    return rows.map((entry) => entry.name);
}

describe("sorting by consumption", () => {
    it("opens with the busiest", () => {
        expect(names(sortByConsumption(ROWS, "cpu"))).toEqual(["busy", "middling", "idle", "stopped"]);
    });

    it("keeps what has no reading at the bottom when the order is turned round", () => {
        expect(names(sortByConsumption(ROWS, "cpu", "asc"))).toEqual(["idle", "middling", "busy", "stopped"]);
    });

    it("sorts by memory on its own terms, not by CPU", () => {
        expect(names(sortByConsumption(ROWS, "memory"))).toEqual(["middling", "idle", "busy", "stopped"]);
    });

    it("sorts by name from A, both ways round", () => {
        expect(names(sortByConsumption(ROWS, "name"))).toEqual(["busy", "idle", "middling", "stopped"]);
        expect(names(sortByConsumption(ROWS, "name", "desc"))).toEqual(["stopped", "middling", "idle", "busy"]);
    });

    it("breaks a tie by name, so turning the order round does not shuffle equals", () => {
        const tied = [row("second", 5, 5), row("first", 5, 5)];

        expect(names(sortByConsumption(tied, "cpu"))).toEqual(["first", "second"]);
        expect(names(sortByConsumption(tied, "cpu", "asc"))).toEqual(["first", "second"]);
    });

    it("leaves the list it was given alone", () => {
        const given = [...ROWS];
        sortByConsumption(given, "cpu");

        expect(names(given)).toEqual(names(ROWS));
    });
});
