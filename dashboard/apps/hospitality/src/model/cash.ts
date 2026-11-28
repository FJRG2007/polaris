/**
 * The till: what should be in the drawer, and the X / Z report of a shift.
 *
 * A cash payment puts `amount + tip` in the drawer (the change handed back is
 * already out of what was tendered). Cash brought in adds, cash taken out
 * subtracts, and the float the shift opened with is there from the start.
 *
 * Pure, in cents.
 */

import { taxInside } from "./pricing";

export interface ShiftPayment {
    readonly method: string;
    readonly amount: number;
    readonly tip: number;
}

export interface ShiftMove {
    readonly kind: "in" | "out" | string;
    readonly amount: number;
}

export function expectedCash(float: number, payments: readonly ShiftPayment[], moves: readonly ShiftMove[]): number {
    const sales = payments.filter((p) => p.method === "cash").reduce((sum, p) => sum + p.amount + p.tip, 0);
    const moved = moves.reduce((sum, m) => sum + (m.kind === "in" ? m.amount : m.kind === "out" ? -m.amount : 0), 0);
    return float + sales + moved;
}

/** Counted minus expected: positive is money over, negative is money short. */
export function countDifference(counted: number, expected: number): number {
    return counted - expected;
}

/** Euro notes and coins, largest first, for counting the drawer by piece. */
export const EUR_DENOMINATIONS = [50_000, 20_000, 10_000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

/** The value of a count given as `{ denomination: pieces }`. */
export function countValue(pieces: Readonly<Record<string, number>>): number {
    return Object.entries(pieces).reduce((sum, [value, count]) => {
        const v = Number(value);
        const n = Math.max(0, Math.floor(count));
        return Number.isFinite(v) ? sum + v * n : sum;
    }, 0);
}

export interface ReportOrder {
    readonly total: number;
    readonly discounts: number;
    readonly covers: number;
    readonly status: string;
    readonly lines: ReadonlyArray<{ name: string; quantity: number; total: number; taxRateBp: number }>;
}

export interface ShiftReport {
    readonly orders: number;
    readonly voided: number;
    readonly covers: number;
    readonly sales: number;
    readonly discounts: number;
    readonly tips: number;
    readonly byMethod: ReadonlyArray<{ method: string; amount: number; count: number }>;
    readonly taxes: ReadonlyArray<{ rateBp: number; base: number; amount: number }>;
    readonly products: ReadonlyArray<{ name: string; quantity: number; total: number }>;
    readonly cashIn: number;
    readonly cashOut: number;
    readonly expected: number;
}

/**
 * One shift's report. The same function draws the X (any time, nothing
 * closes) and the Z (at close, with the count beside it).
 */
export function shiftReport(input: {
    float: number;
    orders: readonly ReportOrder[];
    payments: readonly ShiftPayment[];
    moves: readonly ShiftMove[];
}): ShiftReport {
    const paid = input.orders.filter((o) => o.status === "paid");
    const methods = new Map<string, { amount: number; count: number }>();
    for (const p of input.payments) {
        const row = methods.get(p.method) ?? { amount: 0, count: 0 };
        row.amount += p.amount;
        row.count += 1;
        methods.set(p.method, row);
    }
    const rates = new Map<number, number>();
    const products = new Map<string, { quantity: number; total: number }>();
    for (const order of paid) {
        // The order's own discount is spread over its lines by their totals,
        // the same way the ticket's tax rows were worked out.
        const lineSum = order.lines.reduce((s, l) => s + l.total, 0);
        const factor = lineSum > 0 ? order.total / lineSum : 0;
        for (const line of order.lines) {
            rates.set(line.taxRateBp, (rates.get(line.taxRateBp) ?? 0) + line.total * factor);
            const row = products.get(line.name) ?? { quantity: 0, total: 0 };
            row.quantity += line.quantity;
            row.total += line.total;
            products.set(line.name, row);
        }
    }
    const cashIn = input.moves.filter((m) => m.kind === "in").reduce((s, m) => s + m.amount, 0);
    const cashOut = input.moves.filter((m) => m.kind === "out").reduce((s, m) => s + m.amount, 0);
    return {
        orders: paid.length,
        voided: input.orders.filter((o) => o.status === "void").length,
        covers: paid.reduce((s, o) => s + o.covers, 0),
        sales: paid.reduce((s, o) => s + o.total, 0),
        discounts: paid.reduce((s, o) => s + o.discounts, 0),
        tips: input.payments.reduce((s, p) => s + p.tip, 0),
        byMethod: [...methods.entries()].map(([method, row]) => ({ method, ...row })),
        taxes: [...rates.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([rateBp, amount]) => ({ rateBp, ...taxInside(Math.round(amount), rateBp) })),
        products: [...products.entries()]
            .map(([name, row]) => ({ name, ...row }))
            .sort((a, b) => b.total - a.total),
        cashIn,
        cashOut,
        expected: expectedCash(input.float, input.payments, input.moves)
    };
}
