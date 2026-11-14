/**
 * The street in its parts: which boxes ask for the type, the name, the number,
 * the floor and the door, what each gets, and the street line composed for a
 * page with one box - plus the other emails and phones an identity offers.
 */
import { describe, expect, it } from "vitest";
import * as identity from "../src/lib/identity";
import type { IdentityCard, IdentityValues } from "../src/lib/messages";
import { profilePart, readForm, STREET_TYPE_WORDS, type FieldFacts } from "../src/lib/fields";

function field(over: Partial<FieldFacts> = {}): FieldFacts {
    return { type: "text", autocomplete: "", words: "", usable: true, form: null, ...over };
}

function values(over: Partial<IdentityValues> = {}): IdentityValues {
    return { ...identity.blankIdentity(), ...over };
}

const SPAIN = values({
    address1: "Camino Huertas de la Manga 6",
    streetType: "Camino",
    streetName: "Huertas de la Manga",
    houseNumber: "6",
    floor: "2",
    door: "B",
    country: "ES"
});

describe("the boxes of a split street", () => {
    it("reads them from their words in Spanish", () => {
        const form = readForm([
            field({ words: "correo electrónico" }),
            field({ words: "tipo de vía" }),
            field({ words: "nombre de la vía" }),
            field({ words: "número" }),
            field({ words: "piso" }),
            field({ words: "puerta" }),
            field({ type: "password", autocomplete: "new-password" })
        ]);
        expect(form.profile).toMatchObject({
            streetType: 1,
            streetName: 2,
            houseNumber: 3,
            floor: 4,
            door: 5
        });
    });

    it("reads them from their words in English", () => {
        expect(profilePart(field({ words: "street type" }))).toBe("streetType");
        expect(profilePart(field({ words: "street name" }))).toBe("streetName");
        expect(profilePart(field({ words: "house number" }))).toBe("houseNumber");
        expect(profilePart(field({ words: "floor" }))).toBe("floor");
        expect(profilePart(field({ words: "door" }))).toBe("door");
        // "Street name" says "name", and is still no part of somebody's name.
        const form = readForm([field({ words: "street name" }), field({ type: "password", autocomplete: "new-password" })]);
        expect(form.fullName).toBeNull();
        expect(form.profile.streetName).toBe(0);
    });

    it("never takes another number for the house's", () => {
        expect(profilePart(field({ words: "número de teléfono" }))).toBe("phone");
        expect(profilePart(field({ words: "número de documento" }))).not.toBe("houseNumber");
        expect(profilePart(field({ words: "número de tarjeta" }))).not.toBe("houseNumber");
    });

    it("keeps one box for floor and door as the second line", () => {
        expect(profilePart(field({ words: "piso y puerta" }))).toBe("address2");
        expect(profilePart(field({ words: "address line 2" }))).toBe("address2");
    });

    it("knows a street type dropdown by its words", () => {
        expect(STREET_TYPE_WORDS.test("Tipo de vía")).toBe(true);
        expect(STREET_TYPE_WORDS.test("Street type")).toBe(true);
        expect(STREET_TYPE_WORDS.test("Provincia")).toBe(false);
    });
});

describe("what each street box gets", () => {
    it("gives each part to its own box", () => {
        expect(identity.slotValue(SPAIN, "streetType", null)).toBe("Camino");
        expect(identity.slotValue(SPAIN, "streetName", null)).toBe("Huertas de la Manga");
        expect(identity.slotValue(SPAIN, "houseNumber", null)).toBe("6");
        expect(identity.slotValue(SPAIN, "floor", null)).toBe("2");
        expect(identity.slotValue(SPAIN, "door", null)).toBe("B");
    });

    it("composes the whole line for a page with one street box, in the country's order", () => {
        expect(identity.slotValue(SPAIN, "address1", null)).toBe("Camino Huertas de la Manga 6");
        const us = values({ streetType: "St", streetName: "Main", houseNumber: "6", country: "US" });
        expect(identity.slotValue(us, "address1", null)).toBe("6 Main St");
        const de = values({ streetType: "Straße", streetName: "Haupt", houseNumber: "6", country: "DE" });
        expect(identity.slotValue(de, "address1", null)).toBe("Hauptstraße 6");
        const fr = values({ streetType: "Rue", streetName: "de la Paix", houseNumber: "6", country: "FR" });
        expect(identity.slotValue(fr, "address1", null)).toBe("6 rue de la Paix");
    });

    it("leaves out of the line what the page asks for apart", () => {
        const boxes = { ...identity.NO_STREET_BOXES, streetType: true, houseNumber: true };
        expect(identity.slotValue(SPAIN, "address1", null, boxes)).toBe("Huertas de la Manga");
        expect(identity.slotValue(SPAIN, "address1", null, { ...identity.NO_STREET_BOXES, houseNumber: true })).toBe(
            "Camino Huertas de la Manga"
        );
    });

    it("puts floor and door on the second line only where no box asks for them", () => {
        expect(identity.slotValue(SPAIN, "address2", null)).toBe("2º B");
        expect(identity.slotValue(SPAIN, "address2", null, { ...identity.NO_STREET_BOXES, floor: true })).toBe("");
        expect(identity.slotValue(values({ ...SPAIN, address2: "Escalera 1" }), "address2", null)).toBe("Escalera 1");
    });

    it("fills an older identity as it always did", () => {
        const old = values({ address1: "Somewhere 6, flat 2", address2: "2º B", country: "ES" });
        expect(identity.slotValue(old, "address1", null)).toBe("Somewhere 6, flat 2");
        expect(identity.slotValue(old, "floor", null)).toBe("2º B");
        expect(identity.slotValue(old, "floor", null, { ...identity.NO_STREET_BOXES, door: true })).toBe("");
    });

    it("picks the street type from a dropdown by text or value", () => {
        const options = [
            { value: "", text: "Selecciona" },
            { value: "CL", text: "Calle" },
            { value: "CM", text: "Camino" }
        ];
        expect(identity.pickStreetType(options, "Camino")).toBe(2);
        expect(identity.pickStreetType(options, "calle")).toBe(1);
        expect(identity.pickStreetType(options, "Plaza")).toBe(-1);
        expect(identity.pickStreetType(options, "")).toBe(-1);
    });
});

describe("other emails and phones", () => {
    const card = (over: Partial<IdentityValues>): IdentityCard =>
        identity.cardOf({ id: "a", name: "Home", organizationId: null, isDefault: false, values: values(over) }, new Map());

    it("offers each after the primary, marked to fill instead of it", () => {
        const rows = identity.identityRows(
            [card({ email: "a@x.test", otherEmails: ["b@x.test", "A@x.test"] })],
            "email",
            "Default"
        );
        expect(rows.map((row) => [row.label, row.pick?.value ?? null])).toEqual([
            ["a@x.test", null],
            ["b@x.test", "b@x.test"]
        ]);
        const phones = identity.identityRows([card({ phone: "1", otherPhones: ["2"] })], "phone", "Default");
        expect(phones.map((row) => row.pick)).toEqual([undefined, { key: "phone", value: "2" }]);
    });

    it("leads with the primary alone on any other box", () => {
        const rows = identity.identityRows([card({ email: "a@x.test", otherEmails: ["b@x.test"] })], "name", "Default");
        expect(rows).toHaveLength(1);
    });
});
