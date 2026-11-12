import { describe, expect, it } from "vitest";
import { filterSearchableOptions } from "../src/components/searchable-select";
import { languageOptions } from "../src/components/language-select";

const options = languageOptions(
    [
        { value: "en-US", tag: "en-US", label: "English (US)" },
        { value: "es-ES", tag: "es-ES", label: "Español (España)" }
    ],
    "en-US"
);
const found = (query: string) => filterSearchableOptions(options, query).map((one) => one.value);

describe("languageOptions", () => {
    it("finds a language by its own name, with or without accents", () => {
        expect(found("Español")).toEqual(["es-ES"]);
        expect(found("espanol")).toEqual(["es-ES"]);
    });
    it("finds a language by its English name and its code", () => {
        expect(found("spanish")).toEqual(["es-ES"]);
        expect(found("en-us")).toEqual(["en-US"]);
    });
    it("shows each language in itself", () => {
        expect(options.map((one) => one.label)).toEqual(["English (US)", "Español (España)"]);
    });
});
