/**
 * The arithmetic of an order: totals, discounts, the tax inside, change, splits
 * and bulk price changes - every figure a ticket prints.
 */

import { describe, expect, it } from "vitest";
import {
    allocate,
    changeDue,
    changedPrice,
    discountOf,
    lineTotal,
    orderTotals,
    quickTenders,
    splitEvenly,
    taxInside
} from "@polaris-app/hospitality/src/model/pricing";

describe("line totals", () => {
    it("adds modifiers to the unit price and multiplies by the quantity", () => {
        expect(lineTotal({ unitPrice: 1150, quantity: 2, taxRateBp: 1000, modifiers: [{ name: "cheese", price: 100 }] })).toBe(2500);
    });

    it("takes a line discount off and never goes below zero", () => {
        expect(lineTotal({ unitPrice: 1000, quantity: 1, taxRateBp: 1000, discount: { kind: "percent", value: 1000, reason: "" } })).toBe(900);
        expect(lineTotal({ unitPrice: 1000, quantity: 1, taxRateBp: 1000, discount: { kind: "amount", value: 5000, reason: "" } })).toBe(0);
    });

    it("counts a voided line as nothing", () => {
        expect(lineTotal({ unitPrice: 1000, quantity: 3, taxRateBp: 1000, status: "void" })).toBe(0);
    });

    it("caps a percent discount at 100 %", () => {
        expect(discountOf(1000, { kind: "percent", value: 20_000, reason: "" })).toBe(1000);
    });
});

describe("order totals", () => {
    const lines = [
        { unitPrice: 250, quantity: 2, taxRateBp: 1000 },
        { unitPrice: 1200, quantity: 1, taxRateBp: 2100 },
        { unitPrice: 900, quantity: 1, taxRateBp: 1000, status: "void" }
    ];

    it("sums the live lines and splits the tax by rate", () => {
        const totals = orderTotals(lines);
        expect(totals.total).toBe(1700);
        expect(totals.taxes).toEqual([
            { rateBp: 2100, base: 992, amount: 208 },
            { rateBp: 1000, base: 455, amount: 45 }
        ]);
    });

    it("spreads an order discount over the rates so the tax rows add up to the total", () => {
        const totals = orderTotals(lines, { kind: "percent", value: 1000, reason: "regular" });
        expect(totals.orderDiscount).toBe(170);
        expect(totals.total).toBe(1530);
        expect(totals.taxes.reduce((sum, t) => sum + t.base + t.amount, 0)).toBe(1530);
    });

    it("keeps base plus tax equal to the amount", () => {
        for (const amount of [1, 99, 101, 1234, 99_999]) {
            const share = taxInside(amount, 1000);
            expect(share.base + share.amount).toBe(amount);
        }
    });
});

describe("splitting and paying", () => {
    it("splits a bill evenly to the cent", () => {
        expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    });

    it("allocates by weight with largest remainders", () => {
        expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
        expect(allocate(0, [5, 5])).toEqual([0, 0]);
    });

    it("gives the change and never a negative one", () => {
        expect(changeDue(1730, 2000)).toBe(270);
        expect(changeDue(1730, 1000)).toBe(0);
    });

    it("offers the exact amount and the next notes", () => {
        expect(quickTenders(1730)).toEqual([1730, 1800, 2000, 5000]);
    });
});

describe("bulk price changes", () => {
    it("raises by a percent and rounds to five cents", () => {
        expect(changedPrice(250, { kind: "percent", value: 300, roundTo: 5 })).toBe(260);
    });

    it("adds a fixed amount and never goes below zero", () => {
        expect(changedPrice(250, { kind: "amount", value: 50 })).toBe(300);
        expect(changedPrice(250, { kind: "amount", value: -500 })).toBe(0);
    });
});
