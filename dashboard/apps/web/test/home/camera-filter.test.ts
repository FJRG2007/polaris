/**
 * Finding one camera in a house that has thirty.
 *
 * The two questions people arrive at this list with are "where is the one by the
 * garage" and "show me everything outside", and both of them are answered by
 * matching more than the name: somebody who set a camera up an hour ago
 * remembers its address, and somebody looking in the garden may have called the
 * camera "Back door" and put it in an area called "Garden".
 */

import { describe, expect, it } from "vitest";
import { filterCameras, zonesOf } from "@/lib/home/camera-filter";

const CAMERAS = [
    { name: "Front door", zone: "Outside", address: "192.168.1.10" },
    { name: "Back door", zone: "Garden", address: "192.168.1.11" },
    { name: "Garage", zone: "Outside", address: "192.168.1.12" },
    { name: "Landing", zone: "", address: "192.168.1.13" },
    { name: "Studio Camera", zone: "Inside", address: "192.168.1.143" }
];

describe("the areas a house is using", () => {
    it("counts each one and sorts them by name", () => {
        expect(zonesOf(CAMERAS).slice(0, 3)).toEqual([
            { zone: "Garden", count: 1 },
            { zone: "Inside", count: 1 },
            { zone: "Outside", count: 2 }
        ]);
    });

    it("puts the cameras in no area last", () => {
        // They are a residue rather than a place, and sorted into the middle
        // under an empty name they read as a bug in the list.
        expect(zonesOf(CAMERAS).at(-1)).toEqual({ zone: "", count: 1 });
    });

    it("has nothing to offer for no cameras", () => {
        expect(zonesOf([])).toEqual([]);
    });
});

describe("typing into the list", () => {
    const names = (query: string) =>
        filterCameras(CAMERAS, { query }).map((camera) => camera.name);

    it("finds a camera by its name, in any case", () => {
        expect(names("garage")).toEqual(["Garage"]);
        expect(names("GARAGE")).toEqual(["Garage"]);
    });

    it("finds one by part of its name rather than only the start", () => {
        // "Back door" and "Front door" are both doors, and somebody who types
        // "door" means both of them.
        expect(names("door")).toEqual(["Front door", "Back door"]);
    });

    it("finds one by the area it is in", () => {
        expect(names("outside")).toEqual(["Front door", "Garage"]);
    });

    it("finds one by its address, which is what a camera set up an hour ago is remembered by", () => {
        expect(names("1.143")).toEqual(["Studio Camera"]);
    });

    it("narrows on a second word rather than widening", () => {
        expect(names("garden door")).toEqual(["Back door"]);
        expect(names("outside door")).toEqual(["Front door"]);
    });

    it("shows everything for nothing typed", () => {
        expect(filterCameras(CAMERAS, { query: "   " })).toHaveLength(CAMERAS.length);
        expect(filterCameras(CAMERAS)).toHaveLength(CAMERAS.length);
    });

    it("shows nothing rather than everything for a word that matches nothing", () => {
        expect(names("zxqw")).toEqual([]);
    });
});

describe("picking an area", () => {
    it("shows only that area, matched exactly", () => {
        // Exact, because the picker is built from the areas that exist - a fuzzy
        // match would let "Out" mean both "Outside" and "Outbuilding" with no
        // way to say which was meant.
        expect(filterCameras(CAMERAS, { zone: "Outside" }).map((camera) => camera.name)).toEqual([
            "Front door",
            "Garage"
        ]);
    });

    it("can show the ones filed in no area at all", () => {
        expect(filterCameras(CAMERAS, { zone: "" }).map((camera) => camera.name)).toEqual([
            "Landing"
        ]);
    });

    it("shows every area for null, which is not the same as the empty one", () => {
        expect(filterCameras(CAMERAS, { zone: null })).toHaveLength(CAMERAS.length);
    });

    it("applies with what was typed rather than instead of it", () => {
        expect(
            filterCameras(CAMERAS, { zone: "Outside", query: "door" }).map((camera) => camera.name)
        ).toEqual(["Front door"]);
    });
});
