/**
 * A linked device acts for its own venue only: an order, a line or a menu of
 * another venue answers as if it did not exist, nothing is written, and a
 * manage action never accepts the device at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    order: { id: "o-b", venueId: "venue-b", status: "open", ticketNo: null } as Record<string, unknown> | null,
    transaction: vi.fn(),
    cookie: null as string | null,
    requirePermission: vi.fn(async () => ({ id: "user-1", name: "Ana" }))
}));

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null, PrismaClientKnownRequestError: class extends Error {} },
    prisma: {
        hospitalityOrder: { findUnique: vi.fn(async () => db.order), findFirst: vi.fn(async () => null) },
        hospitalityOrderLine: {
            findUnique: vi.fn(async () => ({ id: "l-b", orderId: "o-b", status: "pending" })),
            findMany: vi.fn(async () => [{ orderId: "o-b", order: { venueId: "venue-b" } }])
        },
        hospitalityTable: { findFirst: vi.fn(async () => ({ id: "t" })) },
        hospitalityDevice: {
            findUnique: vi.fn(async () => ({ id: "dev-1", name: "PDA 1", venueId: "venue-a", revokedAt: null, lastSeenAt: new Date() })),
            update: vi.fn()
        },
        $transaction: db.transaction
    }
}));
vi.mock("@polaris-app/hospitality/src/lib/live", () => ({ publishHospitalityChange: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (db.cookie ? { value: db.cookie } : undefined) }) }));
vi.mock("@polaris/app-host", () => ({
    host: {
        session: { requirePermission: db.requirePermission },
        i18n: { translator: async () => (key: string) => key }
    }
}));
vi.mock("@polaris-app/hospitality/src/lib/i18n", () => ({ hospitalityT: async () => (key: string) => key }));

const orders = await import("@polaris-app/hospitality/src/lib/orders");
const till = await import("@polaris-app/hospitality/src/lib/till");
const { outcome } = await import("@polaris-app/hospitality/src/lib/outcome");

const device = { id: "dev-1", name: "PDA 1", device: true, venueId: "venue-a" } as const;
const line = "00000000-0000-4000-8000-000000000001";

describe("hospitality device principal", () => {
    beforeEach(() => {
        db.transaction.mockClear();
        db.requirePermission.mockClear();
        db.cookie = null;
    });

    it("refuses another venue's order, line and payment, and writes nothing", async () => {
        const refused = { key: "orders.gone" };
        await expect(orders.addLines({ orderId: "o-b", lines: [{ id: line, productId: "p", quantity: 1, course: 0, modifierIds: [], note: "" }] }, device)).rejects.toMatchObject(refused);
        await expect(orders.sendLines("o-b", null, device)).rejects.toMatchObject(refused);
        await expect(orders.removeLine("l-b", device)).rejects.toMatchObject(refused);
        await expect(orders.moveOrder("o-b", "t", device)).rejects.toMatchObject(refused);
        await expect(orders.openOrder({ id: line, venueId: "venue-b", tableId: null, label: "", covers: 1 }, device)).rejects.toMatchObject(refused);
        await expect(till.pay({ orderId: "o-b", payments: [] }, device)).rejects.toMatchObject(refused);
        await expect(till.markLines(["l-b"], true, device)).rejects.toMatchObject(refused);
        await expect(till.markBilled("o-b", device)).rejects.toMatchObject(refused);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it("lets a signed-in person reach any venue they may use", async () => {
        db.transaction.mockResolvedValueOnce(0);
        await expect(orders.sendLines("o-b", null, { id: "user-1", name: "Ana" })).resolves.toBe(0);
        expect(db.transaction).toHaveBeenCalledOnce();
    });

    it("takes the device from its cookie for use, never for manage", async () => {
        db.cookie = "token";
        const seen = await outcome("hospitality.use", async (actor) => ({ actor }));
        expect(seen).toMatchObject({ ok: true, actor: { id: "dev-1", device: true, venueId: "venue-a" } });
        expect(db.requirePermission).not.toHaveBeenCalled();
        const managed = await outcome("hospitality.manage", async (actor) => ({ actor }));
        expect(managed).toMatchObject({ ok: true, actor: { id: "user-1" } });
        expect(db.requirePermission).toHaveBeenCalledWith("hospitality.manage");
    });

    it("answers a refused device in words, not internals", async () => {
        db.cookie = "token";
        const answer = await outcome("hospitality.use", async (actor) => (await orders.sendLines("o-b", null, actor), {}));
        expect(answer).toEqual({ ok: false, error: "orders.gone" });
    });
});
