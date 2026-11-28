/**
 * Moving an order onto a table that already has one merges the two. A payment
 * taken before the till was closed belongs to that closed Z and cannot move,
 * so the waiter gets a sentence that says to move the unpaid items instead -
 * never the database's refusal - and nothing is written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    transaction: vi.fn(async () => undefined),
    closedShifts: 0,
    target: { id: "o-target" } as { id: string } | null
}));

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null, PrismaClientKnownRequestError: class extends Error {} },
    prisma: {
        hospitalityOrder: {
            findUnique: vi.fn(async () => ({ id: "o-1", venueId: "v", status: "open" })),
            findFirst: vi.fn(async () => db.target)
        },
        hospitalityTable: { findFirst: vi.fn(async () => ({ id: "t-2" })) },
        hospitalityPayment: { findMany: vi.fn(async () => [{ shiftId: "s-old" }]) },
        hospitalityShift: { count: vi.fn(async () => db.closedShifts) },
        $transaction: db.transaction
    }
}));
vi.mock("@polaris-app/hospitality/src/lib/live", () => ({ publishHospitalityChange: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@polaris/app-host", () => ({ host: { session: { requirePermission: vi.fn(async () => ({ id: "u", name: "Ana" })) } } }));
vi.mock("@polaris-app/hospitality/src/lib/i18n", () => ({ hospitalityT: async () => (key: string) => key }));

const orders = await import("@polaris-app/hospitality/src/lib/orders");
const { outcome } = await import("@polaris-app/hospitality/src/lib/outcome");
const waiter = { id: "u", name: "Ana" };

describe("hospitality merging a part-paid order", () => {
    beforeEach(() => {
        db.transaction.mockClear();
        db.target = { id: "o-target" };
    });

    it("refuses in words and writes nothing when a payment is in a closed shift", async () => {
        db.closedShifts = 1;
        const answer = await outcome("hospitality.use", async (actor) => ({ id: await orders.moveOrder("o-1", "t-2", actor) }));
        expect(answer).toEqual({ ok: false, error: "orders.paidBeforeClose" });
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it("merges when its payments are all in the open shift", async () => {
        db.closedShifts = 0;
        await expect(orders.moveOrder("o-1", "t-2", waiter)).resolves.toBe("o-target");
        expect(db.transaction).toHaveBeenCalledOnce();
    });

    it("moves to a free table whatever was paid, since no payment moves", async () => {
        db.closedShifts = 1;
        db.target = null;
        await expect(orders.moveOrder("o-1", "t-2", waiter)).resolves.toBe("o-1");
        expect(db.transaction).toHaveBeenCalledOnce();
    });
});
