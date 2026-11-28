/**
 * Everyday money on a check: a comp makes an item exactly free, a discount
 * always carries its reason and writes an audit event, and the register lists
 * every open check with exactly what is left to collect, part-paid first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    audit: vi.fn(async () => undefined),
    service: { rooms: [] as unknown[], orders: [] as unknown[] },
    tx: { hospitalityOrderLine: { updateMany: vi.fn(async () => ({ count: 1 })) }, hospitalityOrder: { update: vi.fn(async () => ({})) } }
}));

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: "DbNull", PrismaClientKnownRequestError: class extends Error {} },
    prisma: {
        hospitalityOrder: { findUnique: vi.fn(async () => ({ venueId: "v", status: "open" })) },
        $transaction: vi.fn(async (run: (tx: unknown) => Promise<void>) => run(db.tx))
    }
}));
vi.mock("@polaris-app/hospitality/src/lib/live", () => ({ publishHospitalityChange: vi.fn() }));
vi.mock("@polaris-app/hospitality/src/lib/audit", async (load) => ({ ...(await load<object>()), audit: db.audit, touchOrder: vi.fn(async () => undefined) }));
vi.mock("@polaris-app/hospitality/src/lib/orders", () => ({ readService: vi.fn(async () => db.service) }));

const till = await import("@polaris-app/hospitality/src/lib/till");
const { readOpenChecks } = await import("@polaris-app/hospitality/src/lib/service-load");
const { discountInput } = await import("@polaris-app/hospitality/src/model/till-schemas");
const { lineTotal, orderTotals } = await import("@polaris-app/hospitality/src/model/pricing");

const ORDER = "0196f1d2-0000-7000-8000-000000000001";
const LINE = "0196f1d2-0000-7000-8000-000000000002";
const manager = { id: "u", name: "Ana" };

describe("hospitality comps and discounts", () => {
    beforeEach(() => db.audit.mockClear());

    it("a comp makes the line exactly free and the check drops by exactly its price", () => {
        const comp = { kind: "percent" as const, value: 10_000, reason: "Birthday" };
        const beer = { unitPrice: 250, quantity: 3, taxRateBp: 1000, modifiers: [{ name: "Big", price: 85 }], discount: comp };
        expect(lineTotal(beer)).toBe(0);
        const water = { unitPrice: 180, quantity: 1, taxRateBp: 1000, modifiers: [] };
        expect(orderTotals([beer, water]).total).toBe(180);
    });

    it("refuses a discount or comp without a reason", () => {
        const base = { orderId: ORDER, lineId: LINE };
        expect(discountInput.safeParse({ ...base, discount: { kind: "percent", value: 10_000, reason: "  " } }).success).toBe(false);
        expect(discountInput.safeParse({ ...base, discount: { kind: "percent", value: 10_000 } }).success).toBe(false);
        expect(discountInput.safeParse({ ...base, discount: { kind: "amount", value: 150, reason: "Cold" } }).success).toBe(true);
        expect(discountInput.safeParse({ ...base, discount: null }).success).toBe(true);
    });

    it("writes one audit event per comp, naming the line and the reason", async () => {
        const discount = { kind: "percent" as const, value: 10_000, reason: "Birthday" };
        await till.setDiscount({ orderId: ORDER, lineId: LINE, discount }, manager);
        expect(db.tx.hospitalityOrderLine.updateMany).toHaveBeenCalledWith({ where: { id: LINE, orderId: ORDER }, data: { discount } });
        expect(db.audit).toHaveBeenCalledOnce();
        expect(db.audit).toHaveBeenCalledWith(expect.anything(), manager, expect.objectContaining({ kind: "order.discount", subjectId: LINE, payload: { discount } }));
    });
});

describe("hospitality open checks on the register", () => {
    const order = (id: string, patch: object) => ({ id, tableId: null, label: "", openedAt: "2026-11-28T12:00:00.000Z", paid: 0, totals: { total: 1000 }, lines: [{}], ...patch });

    it("lists what is left to collect in exact cents, part-paid first, and skips settled or empty checks", async () => {
        db.service = {
            rooms: [{ id: "r", name: "Room", tables: [{ id: "t1", name: "5" }] }],
            orders: [
                order("a", { tableId: "t1", openedAt: "2026-11-28T11:00:00.000Z" }),
                order("b", { label: "Bar", paid: 333, totals: { total: 1001 } }),
                order("c", { paid: 1000 }),
                order("d", { lines: [] })
            ]
        };
        const checks = await readOpenChecks("v");
        expect(checks.map((c) => [c.order.id, c.place, c.left])).toEqual([
            ["b", "Bar", 668],
            ["a", "5", 1000]
        ]);
    });
});
