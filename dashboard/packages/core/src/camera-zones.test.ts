/**
 * The geometry a camera's zones are decided by.
 *
 * Every rule in here is one somebody will hit on their first afternoon with a
 * camera pointed at a drive, and none of them can be checked by looking at a
 * screen: whether a person at the near edge of the drive is on the drive or on
 * the pavement behind them is a question about which point on a box is asked,
 * and the answer only shows up as "it keeps telling me about the road".
 *
 * So it is pinned here instead - no camera, no model, no container.
 */

import * as zoning from "./camera-zones.js";
import { describe, expect, it } from "vitest";

/** A square over the bottom-left quarter of the frame. */
const BOTTOM_LEFT: zoning.ZonePoint[] = [
    { x: 0, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 1 },
    { x: 0, y: 1 }
];

function zone(overrides: Partial<zoning.Zone> = {}): zoning.Zone {
    return {
        id: "z1",
        name: "Drive",
        kind: "watch",
        points: BOTTOM_LEFT,
        objects: [],
        inertia: 1,
        loiterSeconds: 0,
        enabled: true,
        ...overrides
    };
}

/** A box whose feet are in the bottom-left square, and one whose feet are not. */
const INSIDE = { x1: 0.2, y1: 0.4, x2: 0.3, y2: 0.7 };
const OUTSIDE = { x1: 0.7, y1: 0.1, x2: 0.8, y2: 0.3 };

describe("point in polygon", () => {
    it("puts a point inside and outside a square", () => {
        expect(zoning.pointInPolygon({ x: 0.25, y: 0.75 }, BOTTOM_LEFT)).toBe(true);
        expect(zoning.pointInPolygon({ x: 0.75, y: 0.75 }, BOTTOM_LEFT)).toBe(false);
    });

    it("handles a concave outline, which is what a drive around a corner is", () => {
        // An L: the notch at the top right is outside even though it is inside
        // the bounding box.
        const ell: zoning.ZonePoint[] = [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 0.3 },
            { x: 0.3, y: 0.3 },
            { x: 0.3, y: 1 },
            { x: 0, y: 1 }
        ];
        expect(zoning.pointInPolygon({ x: 0.1, y: 0.9 }, ell)).toBe(true);
        expect(zoning.pointInPolygon({ x: 0.9, y: 0.9 }, ell)).toBe(false);
    });

    it("is not an area below three points", () => {
        expect(
            zoning.pointInPolygon({ x: 0.5, y: 0.5 }, [
                { x: 0, y: 0 },
                { x: 1, y: 1 }
            ])
        ).toBe(false);
    });
});

describe("which point on a box decides where it is", () => {
    it("asks where the feet are, not where the middle is", () => {
        // Somebody standing at the near edge of the drive: their feet are in it,
        // the middle of their box is over the pavement above it. Using the
        // centre is what reports them as being on the pavement.
        const person = { x1: 0.2, y1: 0.35, x2: 0.3, y2: 0.6 };
        expect(zoning.groundPoint(person)).toEqual({ x: 0.25, y: 0.6 });
        expect(zoning.zonesContaining([zone()], person, "person")).toEqual(["Drive"]);
    });
});

describe("what the zones allow", () => {
    it("reports everything on a camera nobody has drawn on", () => {
        expect(zoning.zonesAllow([], INSIDE, "person")).toBe(true);
        expect(zoning.zonesAllow([], OUTSIDE, "person")).toBe(true);
    });

    it("narrows to the watched area once one exists", () => {
        expect(zoning.zonesAllow([zone()], INSIDE, "person")).toBe(true);
        expect(zoning.zonesAllow([zone()], OUTSIDE, "person")).toBe(false);
    });

    it("lets an ignore zone win over a watch zone it overlaps", () => {
        const drawn = [zone(), zone({ id: "z2", name: "Pavement", kind: "ignore" })];
        expect(zoning.isIgnored(drawn, INSIDE, "person")).toBe(true);
        expect(zoning.zonesAllow(drawn, INSIDE, "person")).toBe(false);
    });

    it("only narrows for the classes a zone claims", () => {
        const vehicles = [zone({ objects: ["vehicle"] })];
        // The zone has nothing to say about a person, so the camera is unzoned
        // as far as people are concerned.
        expect(zoning.zonesAllow(vehicles, OUTSIDE, "person")).toBe(true);
        expect(zoning.zonesAllow(vehicles, OUTSIDE, "vehicle")).toBe(false);
        expect(zoning.zonesAllow(vehicles, INSIDE, "vehicle")).toBe(true);
    });

    it("ignores a zone that is switched off", () => {
        expect(zoning.zonesAllow([zone({ enabled: false })], OUTSIDE, "person")).toBe(true);
    });
});

describe("inertia and loitering", () => {
    it("waits for the box to settle before saying it is in the zone", () => {
        const drawn = [zone({ inertia: 3 })];
        let state = zoning.NO_PRESENCE;
        state = zoning.advancePresence(state, drawn, INSIDE, "person", 5);
        expect(state.current).toEqual([]);
        state = zoning.advancePresence(state, drawn, INSIDE, "person", 5);
        expect(state.current).toEqual([]);
        state = zoning.advancePresence(state, drawn, INSIDE, "person", 5);
        expect(state.current).toEqual(["Drive"]);
    });

    it("does not lose a settled object to one frame of wobble", () => {
        const drawn = [zone({ inertia: 3 })];
        let state = zoning.NO_PRESENCE;
        for (let frame = 0; frame < 4; frame += 1)
            state = zoning.advancePresence(state, drawn, INSIDE, "person", 5);
        expect(state.current).toEqual(["Drive"]);
        // One frame where the box slipped over the line.
        state = zoning.advancePresence(state, drawn, OUTSIDE, "person", 5);
        expect(state.current).toEqual([]);
        // Back inside, and it counts again on the very next frame rather than
        // starting the count from nothing.
        state = zoning.advancePresence(state, drawn, INSIDE, "person", 5);
        expect(state.current).toEqual(["Drive"]);
    });

    it("holds a loitering zone until the time is up", () => {
        // Two seconds at five frames a second is ten frames.
        const drawn = [zone({ inertia: 1, loiterSeconds: 2 })];
        let state = zoning.NO_PRESENCE;
        for (let frame = 0; frame < 9; frame += 1) {
            state = zoning.advancePresence(state, drawn, INSIDE, "person", 5);
            expect(state.current).toEqual([]);
        }
        state = zoning.advancePresence(state, drawn, INSIDE, "person", 5);
        expect(state.current).toEqual(["Drive"]);
    });

    it("remembers everywhere it has been, not only where it is", () => {
        const drawn = [
            zone({ name: "Drive" }),
            zone({
                id: "z2",
                name: "Door",
                points: [
                    { x: 0.5, y: 0.5 },
                    { x: 1, y: 0.5 },
                    { x: 1, y: 1 },
                    { x: 0.5, y: 1 }
                ]
            })
        ];
        let state = zoning.NO_PRESENCE;
        state = zoning.advancePresence(state, drawn, INSIDE, "person", 5);
        state = zoning.advancePresence(
            state,
            drawn,
            { x1: 0.7, y1: 0.4, x2: 0.8, y2: 0.7 },
            "person",
            5
        );
        expect(state.current).toEqual(["Door"]);
        expect(state.entered).toEqual(["Drive", "Door"]);
    });
});

describe("box arithmetic", () => {
    it("scores overlap between two boxes", () => {
        const a = { x1: 0, y1: 0, x2: 0.2, y2: 0.2 };
        expect(zoning.intersectionOverUnion(a, a)).toBeCloseTo(1);
        expect(zoning.intersectionOverUnion(a, { x1: 0.5, y1: 0.5, x2: 0.7, y2: 0.7 })).toBe(0);
        // Half of each box overlaps, so a third of the space they cover between
        // them.
        expect(zoning.intersectionOverUnion(a, { x1: 0.1, y1: 0, x2: 0.3, y2: 0.2 })).toBeCloseTo(
            1 / 3
        );
    });

    it("tells a tall thing from a wide one", () => {
        expect(zoning.boxRatio({ x1: 0, y1: 0, x2: 0.1, y2: 0.3 })).toBeCloseTo(1 / 3);
        expect(zoning.boxRatio({ x1: 0, y1: 0, x2: 0.3, y2: 0.1 })).toBeCloseTo(3);
    });

    it("knows when something is half out of shot", () => {
        expect(zoning.onEdge({ x1: 0, y1: 0.4, x2: 0.2, y2: 0.9 })).toBe(true);
        expect(zoning.onEdge({ x1: 0.3, y1: 0.4, x2: 0.5, y2: 0.9 })).toBe(false);
    });
});

describe("reading a zone back off a row", () => {
    it("round-trips the points it was given", () => {
        const stored = zoning.serializeZonePoints(BOTTOM_LEFT);
        expect(stored).toBe("[[0,0.5],[0.5,0.5],[0.5,1],[0,1]]");
        expect(zoning.parseZonePoints(stored)).toEqual(BOTTOM_LEFT);
    });

    it("refuses anything that is not an area", () => {
        expect(zoning.parseZonePoints("[[0,0],[1,1]]")).toEqual([]);
        expect(zoning.parseZonePoints("not json")).toEqual([]);
        expect(zoning.parseZonePoints(null)).toEqual([]);
    });

    it("pulls a point drawn off the edge back onto the frame", () => {
        expect(zoning.parseZonePoints("[[-0.2,0.5],[0.5,0.5],[0.5,1.4]]")).toEqual([
            { x: 0, y: 0.5 },
            { x: 0.5, y: 0.5 },
            { x: 0.5, y: 1 }
        ]);
    });
});
