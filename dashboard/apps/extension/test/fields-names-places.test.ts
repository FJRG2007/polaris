/**
 * The parts of somebody's name a sign-up asks for apart - a middle name, the
 * two Spanish surnames - and the country and region dropdowns of an address.
 */
import { describe, expect, it } from "vitest";
import { placePart, profilePart, readForm, type FieldFacts } from "../src/lib/fields";

function field(over: Partial<FieldFacts> = {}): FieldFacts {
    return { type: "text", autocomplete: "", words: "", usable: true, form: null, ...over };
}

function select(over: Partial<FieldFacts> = {}): FieldFacts {
    return field({ type: "select-one", ...over });
}

describe("every part of a name", () => {
    it("reads a middle name as a second given name, by token or by words", () => {
        const form = readForm([
            field({ autocomplete: "given-name" }),
            field({ autocomplete: "additional-name" }),
            field({ autocomplete: "family-name" })
        ]);
        expect(form).toMatchObject({ givenName: 0, middleName: 1, familyName: 2 });

        const spoken = readForm([
            field({ words: "nombre" }),
            field({ words: "segundo nombre" }),
            field({ words: "apellidos" })
        ]);
        expect(spoken).toMatchObject({ givenName: 0, middleName: 1, familyName: 2 });
        expect(readForm([field({ words: "middle name" })]).middleName).toBe(0);
    });

    it("tells the two Spanish surnames apart from the whole family name", () => {
        const form = readForm([
            field({ words: "nombre" }),
            field({ words: "primer apellido" }),
            field({ words: "segundo apellido" })
        ]);
        expect(form).toMatchObject({
            givenName: 0,
            firstSurname: 1,
            secondSurname: 2,
            familyName: null
        });

        for (const [first, second] of [
            ["first surname", "second surname"],
            ["apellido 1", "apellido 2"],
            ["apellido1", "apellido2"],
            ["1er apellido", "2º apellido"]
        ] as const) {
            const split = readForm([field({ words: first }), field({ words: second })]);
            expect(split, first).toMatchObject({ firstSurname: 0, secondSurname: 1 });
        }
    });

    it("keeps the whole family name and the full name where they are asked whole", () => {
        expect(readForm([field({ words: "surname" })]).familyName).toBe(0);
        expect(readForm([field({ words: "nombre completo" })]).fullName).toBe(0);
        expect(readForm([field({ words: "full name" })]).fullName).toBe(0);
    });

    it("still reads a username box as the username", () => {
        const form = readForm([
            field({ words: "nombre de usuario" }),
            field({ words: "segundo nombre" }),
            field({ type: "password", autocomplete: "new-password" })
        ]);
        expect(form).toMatchObject({ username: 0, middleName: 1, givenName: null });
    });
});

describe("address words", () => {
    it("recognises city and region boxes by their own word", () => {
        expect(profilePart(field({ words: "city" }))).toBe("city");
        expect(profilePart(field({ words: "state" }))).toBe("state");
        expect(profilePart(field({ words: "zip" }))).toBe("postalCode");
        expect(profilePart(field({ words: "tel" }))).toBe("phone");
    });

    it("does not read those words inside longer ones", () => {
        expect(profilePart(field({ words: "velocity" }))).toBeNull();
        expect(profilePart(field({ words: "hotel" }))).toBeNull();
    });
});

describe("country and region dropdowns", () => {
    it("reads them by token", () => {
        expect(placePart(select({ autocomplete: "country" }))).toBe("country");
        expect(placePart(select({ autocomplete: "shipping country-name" }))).toBe("country");
        expect(placePart(select({ autocomplete: "address-level1" }))).toBe("state");
        expect(placePart(select({ autocomplete: "address-level2" }))).toBeNull();
    });

    it("reads them by words, in either language", () => {
        expect(placePart(select({ words: "país" }))).toBe("country");
        expect(placePart(select({ words: "provincia" }))).toBe("state");
        expect(placePart(select({ words: "state" }))).toBe("state");
        expect(placePart(select({ words: "language" }))).toBeNull();
    });

    it("leaves out a list of several, a disabled one, and a plain box", () => {
        expect(placePart(field({ type: "select-multiple", words: "country" }))).toBeNull();
        expect(placePart(select({ words: "country", usable: false }))).toBeNull();
        expect(placePart(field({ words: "country" }))).toBeNull();
    });
});
