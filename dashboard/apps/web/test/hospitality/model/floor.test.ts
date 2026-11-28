/**
 * The floor plan's model: a table's state at a glance, the clock since the
 * last thing happened on it, and where its chairs are drawn.
 */

import { describe, expect, it } from "vitest";
import { chairsOf, lastActivity, minutesSince, planBounds, snap, tableState, type FloorOrder } from "@polaris-app/hospitality/src/model/floor";

const order = (patch: Partial<FloorOrder> = {}): FloorOrder => ({
    status: "open",
    openedAt: "2026-11-28T12:00:00.000Z",
    paid: 0,
    totals: { total: 2000 },
    lines: [],
    ...patch
});
const line = (status: string, sentAt: string | null = null) => ({ status, sentAt });

describe("hospitality floor state", () => {
    it("reads each state from the order", () => {
        expect(tableState(undefined)).toBe("free");
        expect(tableState(order())).toBe("seated");
        expect(tableState(order({ lines: [line("void")] }))).toBe("seated");
        expect(tableState(order({ lines: [line("sent", "x"), line("pending")] }))).toBe("pending");
        expect(tableState(order({ lines: [line("sent", "x"), line("ready", "x")] }))).toBe("kitchen");
        expect(tableState(order({ lines: [line("served", "x"), line("ready", "x")] }))).toBe("served");
        expect(tableState(order({ status: "billed", lines: [line("served", "x")] }))).toBe("billed");
        expect(tableState(order({ status: "billed", paid: 500, lines: [line("served", "x")] }))).toBe("paying");
    });

    it("counts from the last round fired, never below zero", () => {
        const o = order({ lines: [line("sent", "2026-11-28T12:30:00.000Z"), line("pending")] });
        const at = lastActivity(o);
        expect(at).toBe(Date.parse("2026-11-28T12:30:00.000Z"));
        expect(minutesSince(at, at + 14 * 60_000 + 59_000)).toBe(14);
        expect(minutesSince(at, at - 60_000)).toBe(0);
    });
});

describe("hospitality floor chairs", () => {
    const box = { x: 2, y: 2, width: 2, height: 2, shape: "square", seats: 4 };

    it("draws one chair per seat outside the table", () => {
        for (const shape of ["square", "round", "long"]) {
            for (const seats of [1, 2, 3, 4, 6, 8, 10]) {
                const table = { ...box, shape, width: shape === "long" ? 4 : 2, seats };
                const chairs = chairsOf(table);
                expect(chairs).toHaveLength(seats);
                for (const c of chairs) {
                    const dx = (c.cx - (table.x + table.width / 2)) / (table.width / 2);
                    const dy = (c.cy - (table.y + table.height / 2)) / (table.height / 2);
                    const inside = shape === "round"
                        ? dx * dx + dy * dy <= 1
                        : c.cx > table.x && c.cx < table.x + table.width && c.cy > table.y && c.cy < table.y + table.height;
                    expect(inside).toBe(false);
                }
            }
        }
    });

    it("puts a square table's four chairs on its two long sides, and a fifth at an end", () => {
        const four = chairsOf(box);
        expect(four.filter((c) => c.cy < box.y)).toHaveLength(2);
        expect(four.filter((c) => c.cy > box.y + box.height)).toHaveLength(2);
        const six = chairsOf({ ...box, seats: 6 });
        expect(six.filter((c) => c.cx < box.x || c.cx > box.x + box.width)).toHaveLength(2);
    });

    it("caps what it draws for a banquet, and draws nothing for no seats", () => {
        expect(chairsOf({ ...box, seats: 60 })).toHaveLength(24);
        expect(chairsOf({ ...box, seats: 0 })).toEqual([]);
    });
});

describe("hospitality floor editor geometry", () => {
    it("snaps to half units and never off the plan", () => {
        expect(snap(3.26)).toBe(3.5);
        expect(snap(3.24)).toBe(3);
        expect(snap(-2)).toBe(0);
    });

    it("fits every table with a margin, and gives an empty room a size", () => {
        expect(planBounds([])).toEqual({ x: 0, y: 0, width: 12, height: 8 });
        expect(planBounds([{ x: 2, y: 3, width: 2, height: 2, shape: "square", seats: 4 }, { x: 10, y: 1, width: 4, height: 2, shape: "long", seats: 8 }])).toEqual({ x: 1, y: 0, width: 14, height: 6 });
    });

    it("stays cheap for a hundred-table floor", () => {
        const tables = Array.from({ length: 150 }, (_, i) => ({ x: (i % 15) * 3, y: Math.floor(i / 15) * 3, width: 2, height: 2, shape: i % 2 ? "round" : "square", seats: 6 }));
        const started = performance.now();
        for (let run = 0; run < 20; run++) for (const t of tables) chairsOf(t);
        expect(performance.now() - started).toBeLessThan(500);
        expect(planBounds(tables).width).toBe(46);
    });
});
