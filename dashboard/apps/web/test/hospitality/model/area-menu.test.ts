/**
 * An area's menu from its three layers, and where its dishes are routed.
 */

import { describe, expect, it } from "vitest";
import { areaItem, routeStation } from "@polaris-app/hospitality/src/model/area-menu";

const beer = { id: "beer", price: 250, available: true, areaId: null };
const cocktail = { id: "mojito", price: 900, available: true, areaId: "rooftop" };

describe("areaItem", () => {
    it("is the plain catalogue for a venue with no areas", () => {
        expect(areaItem(beer, null)).toEqual({ listed: true, price: 250, available: true });
        expect(areaItem(cocktail, null).listed).toBe(false);
    });

    it("layers prices: catalogue, then venue, then area", () => {
        const shared = { id: "terrace", menuMode: "shared" };
        expect(areaItem(beer, shared, { price: 280, available: true }).price).toBe(280);
        expect(areaItem(beer, shared, { price: 280, available: true }, { price: 320, available: null, listed: true }).price).toBe(320);
    });

    it("is sold out when any layer says so", () => {
        const shared = { id: "terrace", menuMode: "shared" };
        expect(areaItem(beer, shared, { price: null, available: false }).available).toBe(false);
        expect(areaItem(beer, shared, null, { price: null, available: false, listed: true }).available).toBe(false);
    });

    it("lists only what a subset or own menu chose, plus an own menu's own products", () => {
        const subset = { id: "disco", menuMode: "subset" };
        expect(areaItem(beer, subset).listed).toBe(false);
        expect(areaItem(beer, subset, null, { price: null, available: null, listed: true }).listed).toBe(true);
        const own = { id: "rooftop", menuMode: "own" };
        expect(areaItem(cocktail, own).listed).toBe(true);
        expect(areaItem(cocktail, { id: "terrace", menuMode: "shared" }).listed).toBe(false);
    });
});

describe("routeStation", () => {
    const rules = [
        { areaId: null, categoryId: "drinks", stationId: "main-bar" },
        { areaId: "terrace", categoryId: "drinks", stationId: "terrace-bar" }
    ];

    it("uses the area's rule, then the venue's, then the category's own", () => {
        expect(routeStation(rules, "terrace", "drinks", "kitchen")).toBe("terrace-bar");
        expect(routeStation(rules, "floor-1", "drinks", "kitchen")).toBe("main-bar");
        expect(routeStation(rules, "terrace", "food", "kitchen")).toBe("kitchen");
        expect(routeStation(rules, null, "drinks", null)).toBe("main-bar");
    });
});
