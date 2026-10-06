/**
 * The tolerant matcher a connected assistant's searches go through.
 *
 * The report it answers: asked to "open the door", an assistant called the
 * device list with "door", the only door in the house is called "Puerta
 * principal" and is a `lock`, and the list said "No devices." - so the model
 * told the person there was no door. What is pinned here: a word finds what it
 * names in another language or by its kind, a typo still finds it, the best
 * match comes first, and a search that matches nothing still answers with
 * something a model can choose from.
 */

import { describe, expect, it } from "vitest";
import {
    ENTITY_SYNONYMS,
    findEntities,
    fallbackNote,
    matchForModel,
    queryTerms,
    rankEntities,
    type SearchField
} from "../src/index.js";

interface Device {
    readonly name: string;
    readonly kind: string;
    readonly zone: string;
}

const FIELDS: readonly SearchField<Device>[] = [
    { text: (device) => device.name, weight: 1 },
    { text: (device) => device.kind, weight: 0.9 },
    { text: (device) => device.zone, weight: 0.7 }
];

const HOUSE: readonly Device[] = [
    { name: "Puerta principal", kind: "lock", zone: "Entrada" },
    { name: "Lámpara", kind: "light", zone: "Salón" },
    { name: "Luz cocina", kind: "light", zone: "Cocina" },
    { name: "Split dormitorio", kind: "climate", zone: "Dormitorio" },
    { name: "Purificador", kind: "air", zone: "Salón" },
    { name: "Enchufe tele", kind: "outlet", zone: "Salón" },
    { name: "Garaje", kind: "opener", zone: "Garaje" },
    { name: "Sensor baño", kind: "sensor", zone: "Baño" }
];

const first = (query: string) => rankEntities(HOUSE, query, FIELDS)[0]?.item.name;

describe("queryTerms", () => {
    it("folds accents and case and drops the words that carry no name", () => {
        expect(queryTerms("Abre la Cerradura, por favor")).toEqual(["cerradura"]);
        expect(queryTerms("luz del Salón")).toEqual(["luz", "salon"]);
    });

    it("keeps a command word when it is all there is", () => {
        expect(queryTerms("open")).toEqual(["open"]);
    });

    it("is empty for an empty query", () => {
        expect(queryTerms("   ")).toEqual([]);
    });
});

describe("rankEntities", () => {
    it("finds a lock by the word for a door, in either language", () => {
        expect(first("door")).toBe("Puerta principal");
        expect(first("puerta")).toBe("Puerta principal");
        expect(first("abre la cerradura")).toBe("Puerta principal");
        expect(first("unlock the front door")).toBe("Puerta principal");
    });

    it("ranks the light in the named room above the other lights", () => {
        expect(first("luz del salon")).toBe("Lámpara");
        expect(first("living room lamp")).toBe("Lámpara");
        expect(first("kitchen light")).toBe("Luz cocina");
    });

    it("finds the air conditioner by what people call it", () => {
        expect(first("aire acondicionado")).toBe("Split dormitorio");
        expect(first("AC")).toBe("Split dormitorio");
        expect(first("air conditioner")).toBe("Split dormitorio");
    });

    it("forgives a typo", () => {
        expect(first("puerat")).toBe("Puerta principal");
        expect(first("purificdor")).toBe("Purificador");
        expect(first("cerradrua")).toBe("Puerta principal");
    });

    it("finds by the start of a word", () => {
        expect(first("purif")).toBe("Purificador");
        expect(first("enchu")).toBe("Enchufe tele");
    });

    it("leaves out what shares nothing with the query", () => {
        expect(rankEntities(HOUSE, "zebra", FIELDS)).toEqual([]);
    });

    it("keeps the given order between equals", () => {
        const lights = rankEntities(HOUSE, "light", FIELDS).map((entry) => entry.item.name);
        expect(lights.slice(0, 2)).toEqual(["Lámpara", "Luz cocina"]);
    });

    it("matches a quoted query as one piece", () => {
        expect(rankEntities(HOUSE, '"luz cocina"', FIELDS).map((entry) => entry.item.name)).toEqual(
            ["Luz cocina"]
        );
    });
});

describe("findEntities", () => {
    it("answers every row, bounded, for an empty query", () => {
        const found = findEntities(HOUSE, "", FIELDS, { limit: 3 });
        expect(found.outcome).toBe("all");
        expect(found.items).toHaveLength(3);
        expect(found.total).toBe(HOUSE.length);
    });

    it("answers the matches when there are some", () => {
        const found = findEntities(HOUSE, "door", FIELDS);
        expect(found.outcome).toBe("matched");
        expect(found.items[0]?.name).toBe("Puerta principal");
    });

    it("never answers nothing: the whole list, bounded, when nothing matched", () => {
        const found = findEntities(HOUSE, "zebra", FIELDS, { limit: 5 });
        expect(found.outcome).toBe("none");
        expect(found.items).toHaveLength(5);
        expect(found.total).toBe(HOUSE.length);
    });

    it("answers nothing only when there is nothing", () => {
        const found = findEntities([], "door", FIELDS);
        expect(found.items).toEqual([]);
        expect(found.total).toBe(0);
    });
});

describe("fallbackNote", () => {
    const noun = { one: "device", other: "devices" };

    it("says nothing when the query matched", () => {
        expect(fallbackNote("door", { outcome: "matched", shown: 1, total: 8 }, noun)).toBeNull();
    });

    it("says the list is everything when nothing matched", () => {
        expect(fallbackNote("zebra", { outcome: "none", shown: 8, total: 8 }, noun)).toBe(
            'No match for "zebra"; these are all 8 devices.'
        );
    });

    it("says how much of the list it is when bounded", () => {
        expect(fallbackNote("zebra", { outcome: "none", shown: 5, total: 8 }, noun)).toBe(
            'No match for "zebra"; these are the first 5 of 8 devices.'
        );
    });
});

describe("matchForModel", () => {
    const noun = { one: "device", other: "devices" };

    it("hands back the matches with no note", () => {
        const found = matchForModel(HOUSE, "puerta", FIELDS, noun);
        expect(found).toMatchObject({ matched: true, note: null });
        expect(found.items[0]?.name).toBe("Puerta principal");
    });

    it("hands back everything, with the sentence that says so", () => {
        const found = matchForModel(HOUSE, "zebra", FIELDS, noun, 2);
        expect(found.matched).toBe(false);
        expect(found.items).toHaveLength(2);
        expect(found.note).toBe('No match for "zebra"; these are the first 2 of 8 devices.');
    });
});

describe("ENTITY_SYNONYMS", () => {
    it("holds every word already folded, one word each", () => {
        for (const words of Object.values(ENTITY_SYNONYMS)) {
            for (const word of words) expect(word).toMatch(/^[a-z0-9]+$/);
        }
    });

    it("names every kind of device Places has", () => {
        for (const kind of [
            "lock",
            "opener",
            "climate",
            "air",
            "switch",
            "outlet",
            "light",
            "sensor",
            "appliance",
            "camera"
        ]) {
            expect(ENTITY_SYNONYMS[kind], kind).toBeDefined();
        }
    });
});
