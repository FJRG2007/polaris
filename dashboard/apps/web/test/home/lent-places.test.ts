/**
 * A visitor is not shown where every property is.
 *
 * A place carries a street address, so the switcher is not a harmless list of
 * names. Opening the Places screens to somebody holding nothing but one grant
 * and then handing them the whole list means the cleaner given the front door
 * gets the address of the office, the warehouse and the parents' house.
 *
 * So the list is narrowed to the places that hold something they were lent, and
 * so is the camera count beside each - which is the other half somebody would
 * forget: "3 cameras" on a place they may watch none of is still an answer about
 * a place that is not theirs.
 */

import type { PlaceView } from "@/lib/home/place-kinds";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    placeId: string | null;
}

let cameras: Row[] = [];
let devices: Row[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        camera: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                cameras.filter((row) => where.id.in.includes(row.id)).map((row) => ({ placeId: row.placeId }))
        },
        placeDevice: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                devices.filter((row) => where.id.in.includes(row.id)).map((row) => ({ placeId: row.placeId }))
        },
        place: { findMany: async () => [], findFirst: async () => null, create: async () => ({}) }
    }
}));

const { placesHolding } = await import("@/lib/home/places");

/** Three properties, of which one is the visitor's business. */
const ALL: PlaceView[] = [
    { id: "p1", name: "Home", kind: "house", address: "1 Example Street", cameras: 3 },
    { id: "p2", name: "Office", kind: "office", address: "2 Example Road", cameras: 5 },
    { id: "p3", name: "Warehouse", kind: "other", address: "3 Example Lane", cameras: 1 }
];

beforeEach(() => {
    cameras = [];
    devices = [];
});

describe("the places a visitor is told about", () => {
    it("are only the ones holding something they were lent", async () => {
        devices = [{ id: "front-door", placeId: "p2" }];
        const shown = await placesHolding("app", ALL, [], ["front-door"]);
        expect(shown.map((place) => place.id)).toEqual(["p2"]);
        // And nothing about the others, the address least of all.
        expect(JSON.stringify(shown)).not.toContain("Example Street");
        expect(JSON.stringify(shown)).not.toContain("Example Lane");
    });

    it("count the cameras they may watch, not the ones that are there", async () => {
        cameras = [{ id: "yard", placeId: "p1" }];
        const [shown] = await placesHolding("app", ALL, ["yard"], []);
        expect(shown?.id).toBe("p1");
        expect(shown?.cameras).toBe(1);
    });

    it("are none at all for somebody lent nothing", async () => {
        expect(await placesHolding("app", ALL, [], [])).toEqual([]);
    });

    it("include the first one for a door that has not been put anywhere yet", async () => {
        // An account is asked what it holds, not where it is, so a door arrives
        // with no place and is drawn under whichever place is being looked at.
        // Answering with no place would leave its holder unable to choose one.
        devices = [{ id: "side-door", placeId: null }];
        const shown = await placesHolding("app", ALL, [], ["side-door"]);
        expect(shown.map((place) => place.id)).toEqual(["p1"]);
    });

    it("say nothing about a place whose id was lent to nobody", async () => {
        // A grant naming a camera that has since been deleted matches no row, so
        // it opens no place either.
        const shown = await placesHolding("app", ALL, ["gone"], []);
        expect(shown).toEqual([]);
    });
});
