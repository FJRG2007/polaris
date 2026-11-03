/**
 * A stored country or region against the dropdowns and boxes real pages have.
 */
import { describe, expect, it } from "vitest";
import {
    countryCode,
    countryText,
    isPlaceholder,
    normalizePlace,
    pickCountry,
    pickRegion,
    placeLocales,
    type PlaceOption
} from "../src/lib/place-match";

const LOCALES = placeLocales("es-ES", ["en-US"]);

function options(...pairs: (readonly [string, string])[]): PlaceOption[] {
    return pairs.map(([value, text]) => ({ value, text }));
}

describe("normalizing a place", () => {
    it("drops accents, case and punctuation", () => {
        expect(normalizePlace("  Côte d'Ivoire ")).toBe("cote d ivoire");
        expect(normalizePlace("ESPAÑA")).toBe("espana");
        expect(normalizePlace("A Coruña,  Galicia")).toBe("a coruna galicia");
    });
});

describe("the languages names are read in", () => {
    it("puts the page first, then the browser, then the fixed ones, each once", () => {
        const locales = placeLocales("fr", ["en-US", "fr"]);
        expect(locales.slice(0, 3)).toEqual(["fr", "en-US", "en"]);
        expect(locales).toContain("es");
        expect(new Set(locales).size).toBe(locales.length);
    });

    it("skips a tag Intl refuses", () => {
        expect(placeLocales("not a tag!", [])[0]).toBe("en");
    });
});

describe("resolving a stored country", () => {
    it("takes a code as written", () => {
        expect(countryCode("ES", LOCALES)).toBe("ES");
        expect(countryCode("es", LOCALES)).toBe("ES");
    });

    it("resolves a name in any of the languages", () => {
        expect(countryCode("España", LOCALES)).toBe("ES");
        expect(countryCode("spain", LOCALES)).toBe("ES");
        expect(countryCode("Espagne", LOCALES)).toBe("ES");
        expect(countryCode("Deutschland", LOCALES)).toBe("DE");
        expect(countryCode("United Kingdom", LOCALES)).toBe("GB");
    });

    it("knows the usual abbreviations", () => {
        expect(countryCode("USA", LOCALES)).toBe("US");
        expect(countryCode("U.S.A.", LOCALES)).toBe("US");
        expect(countryCode("UK", LOCALES)).toBe("GB");
        expect(countryCode("EE.UU.", LOCALES)).toBe("US");
        expect(countryCode("UAE", LOCALES)).toBe("AE");
    });

    it("gives up on what is no country", () => {
        expect(countryCode("Narnia", LOCALES)).toBeNull();
        expect(countryCode("", LOCALES)).toBeNull();
        expect(countryCode("ESP", LOCALES)).toBeNull();
    });
});

describe("a country typed into a text box", () => {
    it("is the name in the page's language", () => {
        expect(countryText("ES", placeLocales("es", []))).toBe("España");
        expect(countryText("España", placeLocales("en", []))).toBe("Spain");
    });

    it("is what was stored when it cannot be resolved", () => {
        expect(countryText(" Narnia ", LOCALES)).toBe("Narnia");
    });
});

describe("placeholders", () => {
    it("are the prompt, never a choice", () => {
        expect(isPlaceholder({ value: "", text: "Spain" })).toBe(true);
        expect(isPlaceholder({ value: "0", text: "Select..." })).toBe(true);
        expect(isPlaceholder({ value: "x", text: "-- Selecciona --" })).toBe(true);
        expect(isPlaceholder({ value: "ES", text: "Spain", disabled: true })).toBe(true);
        expect(isPlaceholder({ value: "ES", text: "Spain" })).toBe(false);
    });
});

describe("picking a country option", () => {
    it("matches a code value", () => {
        const list = options(["", "Select a country"], ["FR", "France"], ["ES", "Spain"]);
        expect(pickCountry(list, "España", LOCALES)).toBe(2);
    });

    it("matches the text in the page's language when the values say nothing", () => {
        const list = options(["0", "Elige un país"], ["17", "Alemania"], ["42", "España"]);
        expect(pickCountry(list, "ES", LOCALES)).toBe(2);
        expect(pickCountry(list, "Spain", LOCALES)).toBe(2);
    });

    it("matches alpha-3 values by their text", () => {
        const list = options(["DEU", "Germany"], ["ESP", "Spain"]);
        expect(pickCountry(list, "ES", LOCALES)).toBe(1);
    });

    it("matches a dropdown that writes the United States its own way", () => {
        const list = options(["CA", "Canada"], ["USA", "United States of America"]);
        expect(pickCountry(list, "US", LOCALES)).toBe(1);
    });

    it("picks nothing when the country is not there or cannot be resolved", () => {
        const list = options(["FR", "France"]);
        expect(pickCountry(list, "ES", LOCALES)).toBe(-1);
        expect(pickCountry(list, "Narnia", LOCALES)).toBe(-1);
    });
});

describe("picking a region option", () => {
    const spain = options(
        ["", "Selecciona una provincia"],
        ["ES-B", "Barcelona"],
        ["ES-MD", "Comunidad de Madrid"],
        ["ES-M", "Madrid"],
        ["ES-ML", "Melilla"]
    );

    it("prefers an exact name", () => {
        expect(pickRegion(spain, "madrid")).toBe(3);
    });

    it("finds a name inside a longer one, and the other way round", () => {
        const regions = options(["", "--"], ["1", "Comunidad de Madrid"], ["2", "Cataluña"]);
        expect(pickRegion(regions, "Madrid")).toBe(1);
        expect(pickRegion(options(["M", "Madrid"]), "Comunidad de Madrid")).toBe(0);
        expect(pickRegion(regions, "Cataluna")).toBe(2);
    });

    it("matches a stored code against the values", () => {
        const states = options(["", "Select..."], ["CA", "California"], ["NY", "New York"]);
        expect(pickRegion(states, "NY")).toBe(2);
    });

    it("never picks the placeholder, and picks nothing for no match", () => {
        expect(pickRegion(spain, "Selecciona")).toBe(-1);
        expect(pickRegion(spain, "Sevilla")).toBe(-1);
        expect(pickRegion(spain, "")).toBe(-1);
    });

    it("does not match half a word", () => {
        expect(pickRegion(options(["1", "Madridejos"]), "Madrid")).toBe(-1);
    });
});
