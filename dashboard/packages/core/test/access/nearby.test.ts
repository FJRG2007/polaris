/**
 * "Only near the place": the fence maths. The failure that matters is somebody
 * let in from the wrong side of town, so most cases are the ones that say no.
 */

import { describe, expect, it } from "vitest";
import {
    grantLinkSchema,
    metresBetween,
    nearbyVerdict,
    NEARBY_MAX_M,
    NEARBY_MIN_M
} from "../../src/access-grants";

/** A front door in Madrid, and points around it. */
const DOOR = { latitude: 40.4168, longitude: -3.7038 };
/** About 55 m north: 0.0005 degrees of latitude. */
const NEXT_DOOR = { latitude: 40.4173, longitude: -3.7038, accuracy: 10 };
/** About 1.1 km north. */
const DOWN_THE_ROAD = { latitude: 40.4268, longitude: -3.7038, accuracy: 10 };

describe("the distance", () => {
    it("is zero to the same point and about right to a known one", () => {
        expect(metresBetween(DOOR, DOOR)).toBe(0);
        // One degree of latitude is about 111.2 km everywhere.
        expect(
            metresBetween({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })
        ).toBeCloseTo(111_195, -2);
    });

    it("is the same both ways", () => {
        expect(metresBetween(DOOR, DOWN_THE_ROAD)).toBeCloseTo(
            metresBetween(DOWN_THE_ROAD, DOOR),
            6
        );
    });
});

describe("the verdict", () => {
    it("lets in somebody at the door", () => {
        expect(nearbyVerdict(DOOR, NEXT_DOOR, 100)).toBe("near");
    });

    it("refuses somebody down the road", () => {
        expect(nearbyVerdict(DOOR, DOWN_THE_ROAD, 100)).toBe("far");
    });

    it("refuses a fix vaguer than the fence rather than guessing", () => {
        expect(nearbyVerdict(DOOR, { ...NEXT_DOOR, accuracy: 500 }, 100)).toBe("vague");
    });

    it("asks for a location when none came", () => {
        expect(nearbyVerdict(DOOR, null, 100)).toBe("unasked");
    });

    it("refuses when the place has nowhere to measure from", () => {
        expect(nearbyVerdict(null, NEXT_DOOR, 100)).toBe("unplaced");
        expect(nearbyVerdict({ latitude: null, longitude: null }, NEXT_DOOR, 100)).toBe("unplaced");
    });

    it("counts the edge of the fence as inside", () => {
        const edge = metresBetween(DOOR, NEXT_DOOR);
        expect(nearbyVerdict(DOOR, NEXT_DOOR, Math.ceil(edge))).toBe("near");
        expect(nearbyVerdict(DOOR, { ...NEXT_DOOR, accuracy: 5 }, Math.floor(edge) - 1)).toBe(
            "far"
        );
    });
});

describe("the fence a grant may draw", () => {
    const parse = (nearbyMeters: number | null) =>
        grantLinkSchema.safeParse({ capability: "control", nearbyMeters }).success;

    it("is none, or between the narrowest and the widest", () => {
        expect(parse(null)).toBe(true);
        expect(parse(NEARBY_MIN_M)).toBe(true);
        expect(parse(NEARBY_MAX_M)).toBe(true);
        expect(parse(NEARBY_MIN_M - 1)).toBe(false);
        expect(parse(NEARBY_MAX_M + 1)).toBe(false);
    });
});
