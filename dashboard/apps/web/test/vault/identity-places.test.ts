import { describe, expect, it } from "vitest";
import { addressLines } from "@/app/(app)/vault/identity-fields";
import {
    countryCodeOf,
    countryLabel,
    countryText,
    normalizePlace,
    regionsOf
} from "@/app/(app)/vault/identity-places";

describe("an identity's country", () => {
    it("is read from a code, a name in any language asked, or a common short form", () => {
        expect(countryCodeOf("es", ["es-ES"])).toBe("ES");
        expect(countryCodeOf("España", ["es-ES"])).toBe("ES");
        expect(countryCodeOf("espana", ["es-ES"])).toBe("ES");
        expect(countryCodeOf("Spain", ["es-ES"])).toBe("ES");
        expect(countryCodeOf("Espagne", ["fr"])).toBe("ES");
        expect(countryCodeOf("USA", ["en-US"])).toBe("US");
        expect(countryCodeOf("United Kingdom", ["es-ES"])).toBe("GB");
    });

    it("keeps text that names no country as text", () => {
        expect(countryCodeOf("Narnia", ["en-US"])).toBeNull();
        expect(countryCodeOf("  ", ["en-US"])).toBeNull();
        expect(countryText("Narnia", "en-US")).toBe("Narnia");
    });

    it("reads in the reader's language", () => {
        expect(countryLabel("DE", "es-ES")).toBe("Alemania");
        expect(countryText("ES", "en-US")).toBe("Spain");
        expect(countryText("Spain", "es-ES")).toBe("España");
    });

    it("is written out by name in an address", () => {
        const lines = addressLines(
            { address1: "Calle Mayor 1", city: "Madrid", postalCode: "28013", country: "ES" },
            (stored) => countryText(stored, "es-ES")
        );
        expect(lines).toEqual(["Calle Mayor 1", "28013 Madrid", "España"]);
    });

    it("compares without accents or punctuation", () => {
        expect(normalizePlace("  Côte d'Ivoire ")).toBe("cote d ivoire");
    });
});

describe("the regions of a country", () => {
    it("come with their short codes", async () => {
        const regions = await regionsOf("ES");
        expect(regions.some((region) => region.name === "Madrid")).toBe(true);
        const california = (await regionsOf("US")).find((region) => region.name === "California");
        expect(california?.code).toBe("CA");
    });

    it("are none for a code the list does not know", async () => {
        expect(await regionsOf("ZZ")).toEqual([]);
    });
});
