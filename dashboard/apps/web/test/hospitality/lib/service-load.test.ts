/**
 * The Service screen's first load is one request, and with the venue the
 * device used last every query starts in the same database round: nothing
 * waits for the menu before asking for the floor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    started: [] as string[],
    venues: [{ id: "v-1" }] as Array<{ id: string }>,
    gate: null as null | Promise<void>,
    open: () => undefined as void
}));

/** Every query records that it started, then waits on one gate. */
function query<T>(name: string, value: () => T) {
    return vi.fn(async () => {
        db.started.push(name);
        await db.gate;
        return value();
    });
}

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null, PrismaClientKnownRequestError: class extends Error {} },
    prisma: {
        hospitalityVenue: { findMany: query("venues", () => db.venues) },
        hospitalityCategory: { findMany: query("categories", () => []) },
        hospitalityProduct: { findMany: query("products", () => []) },
        hospitalityPriceOverride: { findMany: query("overrides", () => []) },
        hospitalityOrderLine: { groupBy: query("sales", () => []) },
        hospitalityRoom: { findMany: query("rooms", () => []) },
        hospitalityOrder: { findMany: query("orders", () => []) }
    }
}));
vi.mock("@polaris-app/hospitality/src/lib/live", () => ({ publishHospitalityChange: vi.fn() }));

const { readServiceScreen } = await import("@polaris-app/hospitality/src/lib/service-load");

const ALL = ["venues", "categories", "products", "overrides", "sales", "rooms", "orders"];

describe("hospitality service first load", () => {
    beforeEach(() => {
        db.started = [];
        db.venues = [{ id: "v-1" }];
        db.gate = new Promise<void>((resolve) => (db.open = resolve));
    });

    it("starts every query at once for the venue this device used last", async () => {
        const answer = readServiceScreen("v-1");
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Nothing has answered yet, and every query is already out.
        expect([...db.started].sort()).toEqual([...ALL].sort());
        db.open();
        const view = await answer;
        expect(view.menu.venueId).toBe("v-1");
        expect(view.service).toEqual({ rooms: [], orders: [] });
        expect(db.started).toHaveLength(ALL.length);
    });

    it("falls back to the first venue when the remembered one is gone, reading its floor once", async () => {
        db.open();
        const view = await readServiceScreen("v-gone");
        expect(view.menu.venueId).toBe("v-1");
        expect(view.service).not.toBeNull();
        // The guess was read and dropped; the real venue's floor read once more.
        expect(db.started.filter((name) => name === "rooms")).toHaveLength(2);
    });

    it("answers no floor when there is no venue yet", async () => {
        db.venues = [];
        db.open();
        const view = await readServiceScreen(null);
        expect(view).toEqual({ menu: { venues: [], venueId: null, categories: [], products: [] }, service: null });
        expect(db.started).not.toContain("rooms");
    });
});
