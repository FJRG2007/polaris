/**
 * The till: what should be in the drawer and the shift report.
 */

import { describe, expect, it } from "vitest";
import { countDifference, countValue, expectedCash, shiftReport } from "@polaris-app/hospitality/src/model/cash";

describe("the drawer", () => {
    const payments = [
        { method: "cash", amount: 1730, tip: 70 },
        { method: "card", amount: 2500, tip: 0 },
        { method: "cash", amount: 500, tip: 0 }
    ];
    const moves = [
        { kind: "in", amount: 2000 },
        { kind: "out", amount: 1500 }
    ];

    it("is the float, the cash taken with its tips, and the moves", () => {
        expect(expectedCash(10_000, payments, moves)).toBe(12_800);
    });

    it("counts by pieces and says over or short", () => {
        expect(countValue({ "2000": 2, "500": 1, "50": 3 })).toBe(4650);
        expect(countDifference(12_700, 12_800)).toBe(-100);
    });

    it("reports a shift by method, tax and product", () => {
        const report = shiftReport({
            float: 10_000,
            payments,
            moves,
            orders: [
                {
                    status: "paid",
                    total: 2200,
                    discounts: 0,
                    covers: 2,
                    lines: [
                        { name: "Beer", quantity: 4, total: 1000, taxRateBp: 1000 },
                        { name: "Burger", quantity: 1, total: 1200, taxRateBp: 1000 }
                    ]
                },
                { status: "void", total: 0, discounts: 0, covers: 1, lines: [] }
            ]
        });
        expect(report.orders).toBe(1);
        expect(report.voided).toBe(1);
        expect(report.sales).toBe(2200);
        expect(report.tips).toBe(70);
        expect(report.byMethod).toEqual([
            { method: "cash", amount: 2230, count: 2 },
            { method: "card", amount: 2500, count: 1 }
        ]);
        expect(report.taxes).toEqual([{ rateBp: 1000, base: 2000, amount: 200 }]);
        expect(report.products[0]).toEqual({ name: "Burger", quantity: 1, total: 1200 });
        expect(report.expected).toBe(12_800);
    });
});
