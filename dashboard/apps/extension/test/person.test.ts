/**
 * What each personal-detail box is taken for, and what goes into it.
 */

import { describe, expect, it } from "vitest";
import type { FieldFacts } from "../src/lib/fields";
import { dateForBox, datePartForBox, personSlot, pickDatePart, pickStatus } from "../src/lib/person";

const box = (words: string, extra: Partial<FieldFacts> = {}): FieldFacts => ({
    type: "text",
    autocomplete: "",
    words,
    usable: true,
    form: null,
    ...extra
});

describe("personSlot", () => {
    it("reads the document, but not its expiry or its type", () => {
        expect(personSlot(box("tu documento de identidad (dni/nie/tie)"), "")).toBe("nationalId");
        expect(personSlot(box("fecha de caducidad del dni"), "")).toBeNull();
        expect(personSlot(box("tipo de documento", { type: "select-one" }), "")).toBeNull();
    });

    it("takes a day box for the birth date only inside a birth group", () => {
        expect(personSlot(box("día"), "")).toBeNull();
        expect(personSlot(box("día"), "tu fecha de nacimiento")).toBe("birthDay");
        expect(personSlot(box("mes", { type: "select-one" }), "fecha de nacimiento")).toBe("birthMonth");
        expect(personSlot(box("año"), "date of birth")).toBe("birthYear");
        expect(personSlot(box("", { autocomplete: "bday" }), "")).toBe("birthDate");
        expect(personSlot(box("fecha de nacimiento"), "")).toBe("birthDate");
    });

    it("tells the country of birth and the nationality from the address", () => {
        expect(personSlot(box("país de nacimiento", { type: "select-one" }), "")).toBe("birthCountry");
        expect(personSlot(box("nacionalidad"), "")).toBe("nationality");
        expect(personSlot(box("país"), "")).toBeNull();
        expect(personSlot(box("estado civil", { type: "select-one" }), "")).toBe("maritalStatus");
    });
});

describe("dates", () => {
    it("writes the whole date in the order the box asks for", () => {
        expect(dateForBox("1990-05-04", { type: "date", hint: "", lang: "es" })).toBe("1990-05-04");
        expect(dateForBox("1990-05-04", { type: "text", hint: "dd/mm/aaaa", lang: "en-US" })).toBe("04/05/1990");
        expect(dateForBox("1990-05-04", { type: "text", hint: "mm/dd/yyyy", lang: "es" })).toBe("05/04/1990");
        expect(dateForBox("1990-05-04", { type: "text", hint: "", lang: "en-US" })).toBe("05/04/1990");
        expect(dateForBox("1990-05-04", { type: "text", hint: "", lang: "de-DE" })).toBe("04.05.1990");
        expect(dateForBox("1990-05-04", { type: "text", hint: "", lang: "es-ES" })).toBe("04/05/1990");
        expect(dateForBox("not a date", { type: "text", hint: "", lang: "es" })).toBe("");
    });

    it("writes each part to the box's length", () => {
        expect(datePartForBox("1990-05-04", "birthDay", 2)).toBe("04");
        expect(datePartForBox("1990-05-04", "birthMonth", null)).toBe("05");
        expect(datePartForBox("1990-05-04", "birthYear", 2)).toBe("90");
    });

    it("picks the month by number or by its name", () => {
        const byNumber = [{ value: "", text: "Mes" }, { value: "4", text: "4" }, { value: "5", text: "5" }];
        expect(pickDatePart(byNumber, "1990-05-04", "birthMonth", ["es"])).toBe(2);
        const byName = [{ value: "", text: "Month" }, { value: "x", text: "Abril" }, { value: "y", text: "Mayo" }];
        expect(pickDatePart(byName, "1990-05-04", "birthMonth", ["es"])).toBe(2);
        const years = [{ value: "", text: "Año" }, { value: "1990", text: "1990" }];
        expect(pickDatePart(years, "1990-05-04", "birthYear", ["es"])).toBe(1);
    });
});

describe("pickStatus", () => {
    it("matches the stored status to the option in the page's words", () => {
        const options = [
            { value: "", text: "Selecciona" },
            { value: "S", text: "Soltero/a" },
            { value: "C", text: "Casado/a" }
        ];
        expect(pickStatus(options, "married")).toBe(2);
        expect(pickStatus(options, "Casada")).toBe(2);
        expect(pickStatus(options, "")).toBe(-1);
    });
});
