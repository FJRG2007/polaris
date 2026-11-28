/**
 * The arithmetic of an order: line totals with their modifiers and discounts,
 * the order's discount, the tax inside each total, the change for a cash
 * payment and an even split of a bill.
 *
 * Every amount is an integer number of cents, tax included (prices in Spain
 * are shown with IVA in). Rounding happens once per step, half away from zero,
 * and anything spread over parts (an order discount over its lines, a bill
 * over its diners) uses largest remainders, so the parts always add back up to
 * the whole to the cent.
 *
 * Pure: the server computes every total with this, and the screen shows the
 * same numbers before the server answers.
 */

export interface Discount {
    /** percent: `value` in basis points (1000 = 10 %). amount: `value` in cents. */
    readonly kind: "percent" | "amount";
    readonly value: number;
    readonly reason: string;
}

export interface PricedModifier {
    readonly name: string;
    readonly price: number;
}

export interface PricedLine {
    readonly unitPrice: number;
    readonly quantity: number;
    readonly taxRateBp: number;
    readonly modifiers?: readonly PricedModifier[] | null;
    readonly discount?: Discount | null;
    readonly status?: string;
}

/** Half away from zero, the way a till rounds. */
export function roundCents(value: number): number {
    return Math.sign(value) * Math.round(Math.abs(value));
}

/** What a discount takes off `gross`: never more than it, never negative. */
export function discountOf(gross: number, discount: Discount | null | undefined): number {
    if (!discount || gross <= 0) return 0;
    const raw =
        discount.kind === "percent"
            ? roundCents((gross * Math.min(Math.max(discount.value, 0), 10_000)) / 10_000)
            : Math.max(0, Math.round(discount.value));
    return Math.min(raw, gross);
}

/** Price of one unit with its modifiers. */
export function unitWithModifiers(line: PricedLine): number {
    return line.unitPrice + (line.modifiers ?? []).reduce((sum, m) => sum + m.price, 0);
}

export function lineGross(line: PricedLine): number {
    return unitWithModifiers(line) * line.quantity;
}

export function lineTotal(line: PricedLine): number {
    if (line.status === "void") return 0;
    const gross = lineGross(line);
    return gross - discountOf(gross, line.discount);
}

/** Splits `total` into parts proportional to `weights`, adding back to `total`. */
export function allocate(total: number, weights: readonly number[]): number[] {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0 || weights.length === 0) return weights.map(() => 0);
    const exact = weights.map((w) => (total * w) / sum);
    const floors = exact.map((x) => Math.floor(x));
    let left = total - floors.reduce((a, b) => a + b, 0);
    const order = exact
        .map((x, i) => ({ i, rest: x - Math.floor(x) }))
        .sort((a, b) => b.rest - a.rest || a.i - b.i);
    for (const { i } of order) {
        if (left <= 0) break;
        floors[i] += 1;
        left -= 1;
    }
    return floors;
}

/** `total` cents into `parts` even shares; the first shares carry the odd cents. */
export function splitEvenly(total: number, parts: number): number[] {
    const n = Math.max(1, Math.floor(parts));
    return allocate(total, Array.from({ length: n }, () => 1));
}

export interface TaxShare {
    readonly rateBp: number;
    readonly base: number;
    readonly amount: number;
}

export interface OrderTotals {
    /** Sum of the line totals (after line discounts). */
    readonly subtotal: number;
    /** What the order's own discount takes off. */
    readonly orderDiscount: number;
    /** Every discount, line and order, together. */
    readonly discounts: number;
    readonly total: number;
    /** The tax inside `total`, per rate, highest rate first. */
    readonly taxes: readonly TaxShare[];
}

/** Base and tax inside a tax-included amount. */
export function taxInside(amount: number, rateBp: number): { base: number; amount: number } {
    const base = roundCents((amount * 10_000) / (10_000 + rateBp));
    return { base, amount: amount - base };
}

export function orderTotals(lines: readonly PricedLine[], discount?: Discount | null): OrderTotals {
    const live = lines.filter((line) => line.status !== "void");
    const totals = live.map(lineTotal);
    const subtotal = totals.reduce((a, b) => a + b, 0);
    const orderDiscount = discountOf(subtotal, discount);
    const lineDiscounts = live.reduce((sum, line) => sum + (lineGross(line) - lineTotal(line)), 0);
    // The order discount comes off each line in proportion, so the tax of each
    // rate is worked out on what was actually charged at that rate.
    const off = allocate(orderDiscount, totals);
    const byRate = new Map<number, number>();
    live.forEach((line, i) => {
        byRate.set(line.taxRateBp, (byRate.get(line.taxRateBp) ?? 0) + totals[i] - off[i]);
    });
    const taxes = [...byRate.entries()]
        .filter(([, amount]) => amount !== 0)
        .sort((a, b) => b[0] - a[0])
        .map(([rateBp, amount]) => ({ rateBp, ...taxInside(amount, rateBp) }));
    return {
        subtotal,
        orderDiscount,
        discounts: lineDiscounts + orderDiscount,
        total: subtotal - orderDiscount,
        taxes
    };
}

/** Change to hand back on a cash payment of `due` with `tendered`. */
export function changeDue(due: number, tendered: number): number {
    return Math.max(0, tendered - due);
}

/** What is left to pay after `paid`. Never below zero. */
export function remainingDue(total: number, paid: number): number {
    return Math.max(0, total - paid);
}

/**
 * Banknotes and coins a customer is likely to hand over for `due`, for the
 * one-tap buttons beside the cash field (exact, then the next round amounts).
 */
export function quickTenders(due: number): number[] {
    if (due <= 0) return [];
    const steps = [100, 200, 500, 1000, 2000, 5000, 10_000];
    const out = new Set<number>([due]);
    for (const step of steps) {
        const up = Math.ceil(due / step) * step;
        if (up > due) out.add(up);
        if (out.size >= 4) break;
    }
    return [...out].sort((a, b) => a - b);
}

/** Bulk price change: a percent (basis points, may be negative) or fixed cents. */
export interface PriceChange {
    readonly kind: "percent" | "amount";
    readonly value: number;
    /** Round the result to this many cents (5 = to 0.05); 1 = no rounding. */
    readonly roundTo?: number;
}

export function changedPrice(price: number, change: PriceChange): number {
    const raw =
        change.kind === "percent" ? price + roundCents((price * change.value) / 10_000) : price + change.value;
    const step = Math.max(1, Math.floor(change.roundTo ?? 1));
    return Math.max(0, Math.round(raw / step) * step);
}
