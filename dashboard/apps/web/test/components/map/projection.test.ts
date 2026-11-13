/**
 * The map's arithmetic: a latitude and longitude land where the pre-projected
 * outlines put that spot, the view never leaves the map, and places that would
 * overlap are drawn as one until zooming parts them.
 */

import * as geo from "@/components/map/projection";
import { describe, expect, it } from "vitest";
import world from "@/components/map/world-map.json";

const SIZE = { w: world.w, h: world.h };
const MADRID = { latitude: 40.42, longitude: -3.7 };
const BARCELONA = { latitude: 41.39, longitude: 2.17 };
const VALENCIA = { latitude: 39.47, longitude: -0.38 };

const spain = world.countries.find((country) => country.c === "ES");

function inside(point: geo.Point, box: readonly number[]): boolean {
    const [left = 0, top = 0, right = 0, bottom = 0] = box;
    return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

describe("projection", () => {
    it("puts Spain's towns inside Spain's outline box", () => {
        expect(spain).toBeDefined();
        for (const town of [MADRID, BARCELONA, VALENCIA]) {
            expect(inside(geo.project(world, town.latitude, town.longitude), spain?.b ?? [])).toBe(
                true
            );
        }
    });

    it("finds its way back from a point to the same coordinates", () => {
        const back = geo.unproject(
            world,
            geo.project(world, BARCELONA.latitude, BARCELONA.longitude)
        );
        expect(back.latitude).toBeCloseTo(BARCELONA.latitude, 6);
        expect(back.longitude).toBeCloseTo(BARCELONA.longitude, 6);
    });

    it("stops at the latitudes every web map stops at instead of running to infinity", () => {
        const pole = geo.project(world, 90, 0);
        expect(Number.isFinite(pole.y)).toBe(true);
    });
});

describe("the view", () => {
    it("keeps the point under the pointer where it is while zooming", () => {
        const at = { x: 470, y: 324 };
        const view = geo.zoomAt(geo.WHOLE, 4, at, SIZE);
        const after = geo.onScreen(view, geo.onMap(geo.WHOLE, at));
        expect(after.x).toBeCloseTo(at.x, 6);
        expect(after.y).toBeCloseTo(at.y, 6);
    });

    it("never zooms out past the whole map nor in past the limit", () => {
        expect(geo.zoomAt(geo.WHOLE, 0.1, { x: 10, y: 10 }, SIZE)).toEqual(geo.WHOLE);
        expect(geo.zoomAt(geo.WHOLE, 1000, { x: 10, y: 10 }, SIZE).zoom).toBe(geo.MAX_ZOOM);
    });

    it("never pans the map out of its box", () => {
        expect(geo.panBy(geo.WHOLE, 500, 500, SIZE)).toEqual(geo.WHOLE);
        const zoomed = geo.zoomAt(geo.WHOLE, 2, { x: 0, y: 0 }, SIZE);
        const far = geo.panBy(zoomed, -1e6, -1e6, SIZE);
        expect(far.x).toBe(SIZE.w - SIZE.w * 2);
        expect(far.y).toBe(SIZE.h - SIZE.h * 2);
    });

    it("fits a country's box in view, centred", () => {
        const box = spain?.b as unknown as geo.Box;
        const view = geo.fit(box, SIZE, 0);
        const middle = geo.onScreen(view, { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 });
        expect(view.zoom).toBeGreaterThan(10);
        expect(middle.x).toBeCloseTo(SIZE.w / 2, 3);
        expect(middle.y).toBeCloseTo(SIZE.h / 2, 3);
        expect(geo.boxOf([])).toEqual([Infinity, Infinity, -Infinity, -Infinity]);
    });
});

describe("clustering", () => {
    const towns = [
        { id: "mad", ...MADRID },
        { id: "bcn", ...BARCELONA },
        { id: "vlc", ...VALENCIA },
        { id: "nyc", latitude: 40.71, longitude: -74.0 }
    ].map((town) => ({ ...geo.project(world, town.latitude, town.longitude), item: town }));

    it("draws one country's towns as one marker on the whole map, apart from another continent's", () => {
        const groups = geo.cluster(towns, geo.WHOLE, 22, (town) => town.id);
        expect(groups.map((group) => group.key)).toEqual(["bcn|mad|vlc", "nyc"]);
    });

    it("parts them once zoomed into the country", () => {
        const spain = geo.cluster(towns.slice(0, 3), geo.WHOLE, 22, (town) => town.id)[0];
        const opened = geo.openCluster(spain?.members ?? [], SIZE, 22);
        expect(opened.kind).toBe("zoom");
        if (opened.kind !== "zoom") return;
        const groups = geo.cluster(towns, opened.view, 22, (town) => town.id);
        expect(
            groups.filter((group) => group.members.length === 1).map((group) => group.key)
        ).toEqual(expect.arrayContaining(["mad", "bcn", "vlc"]));
    });

    it("lays out places no zoom can part around their spot", () => {
        const same = [0, 1, 2].map((index) => ({ x: 470, y: 324, item: { id: String(index) } }));
        expect(geo.openCluster(same, SIZE, 22)).toEqual({ kind: "fan" });
        const spots = geo.fan({ x: 0, y: 0 }, 4, 10);
        expect(spots[0]?.x).toBeCloseTo(0, 6);
        expect(spots[0]?.y).toBeCloseTo(-10, 6);
        expect(new Set(spots.map((spot) => `${spot.x.toFixed(3)},${spot.y.toFixed(3)}`)).size).toBe(
            4
        );
    });
});
