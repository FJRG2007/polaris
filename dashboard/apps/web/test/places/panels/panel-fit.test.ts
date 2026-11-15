/**
 * A wall panel's cards fill the screen they are on: never below the panel's
 * card size, never on top of each other, never past the screen's edge, and on
 * a second page when a screen cannot hold them all.
 */

import { describe, expect, it } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import {
    CELL_MIN,
    fitPanel,
    preferredSpan,
    primaryAction,
    wallReading,
    type FitCard,
    type FitPlacement
} from "@polaris-app/places/src/lib/panel-fit";

function cards(count: number, type: FitCard["type"] = "device"): FitCard[] {
    return Array.from({ length: count }, (_, index) => ({ id: `c${index}`, type, w: 3, h: 2 }));
}

function overlap(a: FitPlacement, b: FitPlacement): boolean {
    return (
        a.page === b.page &&
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
    );
}

function sound(fit: ReturnType<typeof fitPanel>, count: number): void {
    expect(fit.placements).toHaveLength(count);
    for (const placement of fit.placements) {
        expect(placement.x + placement.w).toBeLessThanOrEqual(fit.columns);
        expect(placement.y + placement.h).toBeLessThanOrEqual(fit.rows);
        expect(placement.page).toBeLessThan(fit.pages);
    }
    fit.placements.forEach((a, i) =>
        fit.placements.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false))
    );
}

describe("fitPanel", () => {
    it("fits a landscape tablet's cards on one page at no less than the card size", () => {
        const fit = fitPanel({ width: 1280, height: 760, cards: cards(8), cardSize: "medium", gap: 12 });
        sound(fit, 8);
        expect(fit.pages).toBe(1);
        expect(fit.cellW).toBeGreaterThanOrEqual(CELL_MIN.medium);
        expect(fit.cellH).toBeGreaterThanOrEqual(CELL_MIN.medium);
    });

    it("uses fewer columns held portrait than landscape", () => {
        const wide = fitPanel({ width: 1280, height: 800, cards: cards(6), cardSize: "medium", gap: 12 });
        const tall = fitPanel({ width: 800, height: 1280, cards: cards(6), cardSize: "medium", gap: 12 });
        expect(tall.columns).toBeLessThan(wide.columns);
        expect(tall.rows).toBeGreaterThan(wide.rows);
        sound(tall, 6);
    });

    it("pages cards a screen cannot hold instead of shrinking them", () => {
        const fit = fitPanel({ width: 800, height: 600, cards: cards(30), cardSize: "large", gap: 12 });
        sound(fit, 30);
        expect(fit.pages).toBeGreaterThan(1);
        expect(fit.cellW).toBeGreaterThanOrEqual(CELL_MIN.large);
        expect(fit.cellH).toBeGreaterThanOrEqual(CELL_MIN.large);
    });

    it("keeps the arranged order on the page", () => {
        const fit = fitPanel({ width: 1280, height: 800, cards: cards(5), cardSize: "small", gap: 8 });
        const order = [...fit.placements]
            .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
            .map((placement) => placement.id);
        expect(order).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    });

    it("gives a phone-sized screen one column, a card wider than it included", () => {
        const fit = fitPanel({
            width: 360,
            height: 640,
            cards: [...cards(2), { id: "cam", type: "camera", w: 6, h: 4 }],
            cardSize: "large",
            gap: 8
        });
        expect(fit.columns).toBe(1);
        sound(fit, 3);
    });

    it("reads a zero-sized box without failing", () => {
        const fit = fitPanel({ width: 0, height: 0, cards: cards(3), cardSize: "medium", gap: 8 });
        sound(fit, 3);
        expect(fit.columns).toBe(1);
    });

    it("spans by kind and by the size somebody arranged", () => {
        expect(preferredSpan({ id: "a", type: "device", w: 3, h: 2 })).toEqual({ w: 1, h: 1 });
        expect(preferredSpan({ id: "a", type: "device", w: 3, h: 2, kind: "climate" })).toEqual({ w: 2, h: 1 });
        expect(preferredSpan({ id: "a", type: "camera", w: 4, h: 3 })).toEqual({ w: 2, h: 2 });
        expect(preferredSpan({ id: "a", type: "device", w: 6, h: 4 })).toEqual({ w: 2, h: 2 });
    });
});

function device(overrides: Partial<DeviceView>): DeviceView {
    return {
        id: "d",
        vendor: "x",
        kind: "switch",
        name: "D",
        zone: "",
        placeId: null,
        model: "",
        firmware: "",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        ...overrides
    } as DeviceView;
}

describe("primaryAction", () => {
    it("is the one press a card is mostly used for", () => {
        expect(primaryAction(device({ kind: "lock", state: "locked" }))).toBe("unlock");
        expect(primaryAction(device({ kind: "lock", state: "unlocked" }))).toBe("lock");
        expect(primaryAction(device({ kind: "opener" }))).toBe("unlatch");
        expect(primaryAction(device({ kind: "switch", state: "on" }))).toBe("turn-off");
        expect(primaryAction(device({ kind: "climate", state: "off" }))).toBe("turn-on");
        expect(primaryAction(device({ kind: "litter" }))).toBe("clean");
        expect(primaryAction(device({ kind: "sensor" }))).toBeNull();
        expect(primaryAction(device({ kind: "appliance" }))).toBeNull();
    });

    it("shows no reading for a device that is not answering", () => {
        expect(wallReading(device({ kind: "climate", online: false }))).toBeNull();
    });
});
