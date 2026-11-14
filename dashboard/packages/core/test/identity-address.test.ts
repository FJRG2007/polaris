import * as core from "../src/index";
import { describe, expect, it } from "vitest";

const street = (streetType: string, streetName: string, houseNumber: string) => ({ streetType, streetName, houseNumber });

describe("the street line in its parts", () => {
    it("offers the country's own street types, and a generic list elsewhere", () => {
        expect(core.streetTypesFor("ES")).toContain("Caserío");
        expect(core.streetTypesFor("es")).toContain("Camino");
        expect(core.streetTypesFor("US")).toContain("Blvd");
        expect(core.streetTypesFor("FR")).toContain("Impasse");
        expect(core.streetTypesFor("AT")).toContain("Gasse");
        expect(core.streetTypesFor("BR")).toContain("Rua");
        expect(core.streetTypesFor("")).toContain("Street");
        expect(core.streetTypesFor("JP")).toContain("Street");
    });

    it("composes the line in each country's order", () => {
        expect(core.composeStreet(street("Camino", "Huertas de la Manga", "6"), "ES")).toBe("Camino Huertas de la Manga 6");
        expect(core.composeStreet(street("St", "Main", "6"), "US")).toBe("6 Main St");
        expect(core.composeStreet(street("Road", "Abbey", "3"), "GB")).toBe("3 Abbey Road");
        expect(core.composeStreet(street("Rue", "de la Paix", "6"), "FR")).toBe("6 rue de la Paix");
        expect(core.composeStreet(street("Via", "Roma", "10"), "IT")).toBe("Via Roma 10");
        expect(core.composeStreet(street("Rua", "Augusta", "5"), "PT")).toBe("Rua Augusta 5");
    });

    it("writes German street names the way German spells them", () => {
        expect(core.composeStreet(street("Straße", "Haupt", "6"), "DE")).toBe("Hauptstraße 6");
        expect(core.composeStreet(street("Straße", "Berliner", "6"), "DE")).toBe("Berliner Straße 6");
        expect(core.composeStreet(street("Straße", "Albert Schweitzer", "6"), "DE")).toBe("Albert-Schweitzer-Straße 6");
        expect(core.composeStreet(street("", "Hauptstraße", "6"), "DE")).toBe("Hauptstraße 6");
        expect(core.composeStreet(street("Straße", "Hauptstraße", "6"), "DE")).toBe("Hauptstraße 6");
    });

    it("leaves out what is empty", () => {
        expect(core.composeStreet(street("", "Camino Huertas de la Manga N6", ""), "ES")).toBe("Camino Huertas de la Manga N6");
        expect(core.composeStreet(street("", "", ""), "US")).toBe("");
    });

    it("writes the floor and the door", () => {
        expect(core.composeFloorDoor({ floor: "2", door: "B" }, "ES")).toBe("2º B");
        expect(core.composeFloorDoor({ floor: "Bajo", door: "" }, "ES")).toBe("Bajo");
        expect(core.composeFloorDoor({ floor: "2", door: "B" }, "FR")).toBe("2 B");
    });

    it("reads an old line only when it is certain", () => {
        expect(core.parseStreet("Camino Huertas de la Manga N6", "ES")).toEqual({
            streetType: "Camino",
            streetName: "Huertas de la Manga",
            houseNumber: "6",
            floor: "",
            door: ""
        });
        expect(core.parseStreet("calle Mayor, nº 12", "ES")?.houseNumber).toBe("12");
        expect(core.parseStreet("Travesia del Sol 3B", "ES")).toMatchObject({ streetType: "Travesía", houseNumber: "3B" });
        // No type it knows, no number, or a country that writes the number first.
        expect(core.parseStreet("Huertas de la Manga 6", "ES")).toBeNull();
        expect(core.parseStreet("Calle Mayor", "ES")).toBeNull();
        expect(core.parseStreet("Calle 6", "ES")).toBeNull();
        expect(core.parseStreet("6 Main St", "US")).toBeNull();
    });

    it("keeps stored parts while they match the line, and reads the line again when not", () => {
        const stored = { streetType: "Calle", streetName: "Mayor", houseNumber: "6", floor: "2", door: "B" };
        expect(core.streetParts(stored, "Calle Mayor 6", "ES")).toEqual(stored);
        // Changed by another client: read again, the floor and door kept.
        expect(core.streetParts(stored, "Avenida del Mar 9", "ES")).toEqual({
            ...stored,
            streetType: "Avenida",
            streetName: "del Mar",
            houseNumber: "9"
        });
        const blank = core.readAddress([]);
        // Unreadable: whole as the name, which composes to the same line.
        const kept = core.streetParts(blank, "Somewhere 6, flat 2", "ES");
        expect(kept.streetName).toBe("Somewhere 6, flat 2");
        expect(core.composeStreet(kept, "ES")).toBe("Somewhere 6, flat 2");
        expect(core.streetParts(blank, "", "ES")).toEqual(blank);
    });

    it("stores the parts as named custom fields, only where they changed", () => {
        const parts = core.normalizeAddress({ streetType: " Calle ", streetName: "Mayor", houseNumber: "6" });
        const fields = core.writeAddress([] as { name: string; value: string; type: number }[], parts);
        expect(fields.map((field) => field.name)).toEqual(["Street type", "Street name", "House number"]);
        expect(core.readAddress(fields)).toEqual(parts);
        expect(core.writeAddress(fields, parts)).toEqual(fields);
    });
});

describe("several emails and phones", () => {
    it("stores the extras numbered from 2, and drops the slots no longer used", () => {
        let fields = core.writeContacts([] as { name: string; value: string; type: number }[], {
            emails: ["b@example.com", "", "c@example.com"],
            phones: ["+34 600 000 000"]
        });
        expect(fields.map((field) => field.name)).toEqual(["Email 2", "Email 3", "Phone 2"]);
        expect(core.readContacts(fields)).toEqual({ emails: ["b@example.com", "c@example.com"], phones: ["+34 600 000 000"] });
        fields = core.writeContacts(fields, { emails: ["c@example.com"], phones: [] });
        expect(fields.map((field) => [field.name, field.value])).toEqual([["Email 2", "c@example.com"]]);
        expect(core.isContactField("Email 2")).toBe(true);
        expect(core.isContactField("Email 1")).toBe(false);
    });

    it("normalizes and checks each one", () => {
        expect(core.normalizeContactEmail("  Ada@Example.COM ")).toBe("ada@example.com");
        expect(core.normalizeContactPhone(" +34  600 000  000 ")).toBe("+34 600 000 000");
        expect(core.looksLikePhone("+34 (600) 000-000")).toBe(true);
        expect(core.looksLikePhone("call me")).toBe(false);
    });
});
