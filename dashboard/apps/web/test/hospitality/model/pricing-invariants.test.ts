/**
 * The money invariants, fuzzed: random orders with random discounts, splits
 * and taxes must add back up to the cent, every time. A seeded generator keeps
 * every run identical, so a failure prints a seed that reproduces it.
 */

import { describe, expect, it } from "vitest";
import { allocate, itemsDue, lineTotal, orderTotals, splitEvenly, type Discount } from "@polaris-app/hospitality/src/model/pricing";

/** mulberry32: small, fast, deterministic. */
function random(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

const RATES = [0, 400, 1000, 2100];

function order(next: () => number) {
    const int = (max: number) => Math.floor(next() * (max + 1));
    const discount = (): Discount | null => {
        const roll = next();
        if (roll < 0.5) return null;
        return roll < 0.75 ? { kind: "percent", value: 1 + int(9_999), reason: "" } : { kind: "amount", value: 1 + int(5_000), reason: "" };
    };
    const lines = Array.from({ length: 1 + int(15) }, (_, i) => ({
        id: `l${i}`,
        unitPrice: int(4_000),
        quantity: 1 + int(6),
        taxRateBp: RATES[int(3)] ?? 1000,
        modifiers: next() < 0.3 ? [{ name: "extra", price: int(300) - 50 }] : [],
        discount: discount(),
        status: next() < 0.1 ? "void" : "sent"
    }));
    return { lines, discount: discount() };
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

describe("money invariants (fuzzed)", () => {
    it("total = subtotal - order discount, taxes add up to the total, nothing negative", () => {
        for (const seed of SEEDS) {
            const { lines, discount } = order(random(seed));
            const totals = orderTotals(lines, discount);
            expect(Number.isInteger(totals.total), `seed ${seed}`).toBe(true);
            expect(totals.total, `seed ${seed}`).toBe(totals.subtotal - totals.orderDiscount);
            expect(totals.total, `seed ${seed}`).toBeGreaterThanOrEqual(0);
            const taxed = totals.taxes.reduce((sum, x) => sum + x.base + x.amount, 0);
            expect(taxed, `seed ${seed}`).toBe(totals.total);
            for (const x of totals.taxes) expect(Number.isInteger(x.base) && Number.isInteger(x.amount), `seed ${seed}`).toBe(true);
        }
    });

    it("paying every line by item sums to the bill exactly", () => {
        for (const seed of SEEDS) {
            const { lines, discount } = order(random(seed));
            const live = lines.filter((l) => l.status !== "void");
            const total = orderTotals(lines, discount).total;
            const each = live.reduce((sum, l) => sum + itemsDue(live, total, new Set([l.id])), 0);
            expect(each, `seed ${seed}`).toBe(itemsDue(live, total, new Set(live.map((l) => l.id))));
            if (live.some((l) => lineTotal(l) > 0)) expect(each, `seed ${seed}`).toBe(total);
        }
    });

    it("an even split and any allocation keep every cent", () => {
        for (const seed of SEEDS) {
            const next = random(seed);
            const total = Math.floor(next() * 1_000_000);
            const parts = 1 + Math.floor(next() * 30);
            const split = splitEvenly(total, parts);
            expect(split.reduce((a, b) => a + b, 0), `seed ${seed}`).toBe(total);
            expect(Math.max(...split) - Math.min(...split), `seed ${seed}`).toBeLessThanOrEqual(1);
            const weights = Array.from({ length: parts }, () => Math.floor(next() * 5_000));
            const shares = allocate(total, weights);
            const expected = weights.some((w) => w > 0) ? total : 0;
            expect(shares.reduce((a, b) => a + b, 0), `seed ${seed}`).toBe(expected);
        }
    });
});
