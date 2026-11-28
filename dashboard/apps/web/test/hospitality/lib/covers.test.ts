/**
 * Guests at a table: a change is written with its audit event and published,
 * so every floor fills the chairs live; another venue's device and a closed
 * order are refused, and the same number writes nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    order: { venueId: "v", status: "open", covers: 2 } as { venueId: string; status: string; covers: number } | null,
    transaction: vi.fn(async (run: (tx: unknown) => Promise<void>) => run(db.tx)),
    tx: {
        hospitalityOrder: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
        hospitalityAudit: { create: vi.fn(async () => ({})) }
    },
    published: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null, PrismaClientKnownRequestError: class extends Error {} },
    prisma: { hospitalityOrder: { findUnique: vi.fn(async () => db.order) }, $transaction: db.transaction }
}));
vi.mock("@polaris-app/hospitality/src/lib/live", () => ({ publishHospitalityChange: db.published }));
vi.mock("@polaris-app/hospitality/src/lib/audit", async (load) => ({
    ...(await load<object>()),
    audit: vi.fn(async () => undefined),
    touchOrder: vi.fn(async () => undefined)
}));

const orders = await import("@polaris-app/hospitality/src/lib/orders");
const waiter = { id: "u", name: "Ana" };

describe("hospitality covers", () => {
    beforeEach(() => {
        db.order = { venueId: "v", status: "open", covers: 2 };
        db.transaction.mockClear();
        db.published.mockClear();
        db.tx.hospitalityOrder.update.mockClear();
    });

    it("writes the new number and tells every floor", async () => {
        await orders.setCovers("o-1", 5, waiter);
        expect(db.tx.hospitalityOrder.update).toHaveBeenCalledWith({ where: { id: "o-1" }, data: { covers: 5 } });
        expect(db.published).toHaveBeenCalledWith(expect.objectContaining({ venueId: "v", topic: "orders" }));
    });

    it("writes nothing when the number is the same", async () => {
        await orders.setCovers("o-1", 2, waiter);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it("refuses a closed order and another venue's device", async () => {
        db.order = { venueId: "v", status: "paid", covers: 2 };
        await expect(orders.setCovers("o-1", 3, waiter)).rejects.toThrow();
        db.order = { venueId: "v", status: "open", covers: 2 };
        await expect(orders.setCovers("o-1", 3, { id: "d", name: "PDA", device: true, venueId: "other" } as never)).rejects.toThrow();
        expect(db.transaction).not.toHaveBeenCalled();
    });
});
