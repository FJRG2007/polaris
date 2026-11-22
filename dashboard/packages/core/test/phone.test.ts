import { describe, expect, it } from "vitest";
import { phoneField, phoneShapeField } from "../src/schemas/two-factor.js";
import {
    defaultPhoneCountry,
    formatPhoneAsTyped,
    formatPhoneInternational,
    isPhoneCountry,
    phoneCountries,
    phoneCallingCode,
    phoneMainCountry,
    phoneCountryFromLocales,
    phoneCountryOf,
    splitPhone,
    toE164
} from "../src/phone.js";

// Fixture numbers only: the Spanish one is a placeholder in the 600 mobile
// range and the US one sits in 555-01XX, which is reserved for fiction.
const SPAIN = "+34600111222";
const US = "+12015550123";

describe("toE164", () => {
    it("keeps a whole international number", () => {
        expect(toE164(SPAIN)).toBe(SPAIN);
        expect(toE164("+34 600 11 12 22")).toBe(SPAIN);
    });

    it("reads a national number only as the country it is given", () => {
        expect(toE164("600 11 12 22", "ES")).toBe(SPAIN);
        expect(toE164("600111222")).toBeNull();
    });

    it("refuses a number its country could not have", () => {
        expect(toE164("+3460011")).toBeNull();
        expect(toE164("+34600111222333")).toBeNull();
        expect(toE164("")).toBeNull();
    });
});

describe("splitPhone", () => {
    it("splits a stored number into its country and national part", () => {
        expect(splitPhone(SPAIN)).toEqual({ country: "ES", national: "600 11 12 22" });
        expect(phoneCountryOf(US)).toBe("US");
    });

    it("hands back an old value it cannot read whole, rather than losing it", () => {
        expect(splitPhone("600 111 222")).toEqual({ national: "600 111 222" });
    });
});

describe("formatting", () => {
    it("groups what has been typed as the country writes it", () => {
        expect(formatPhoneAsTyped("600111222", "ES")).toBe("600 11 12 22");
        expect(formatPhoneInternational(SPAIN)).toBe("+34 600 11 12 22");
    });
});

describe("countries", () => {
    it("knows every country's calling code", () => {
        expect(phoneCountries().length).toBeGreaterThan(200);
        expect(phoneCallingCode("ES")).toBe("34");
        expect(isPhoneCountry("ES")).toBe(true);
        expect(isPhoneCountry("XX")).toBe(false);
        expect(phoneMainCountry("1")).toBe("US");
        expect(phoneMainCountry("44")).toBe("GB");
        expect(phoneMainCountry("999")).toBeUndefined();
    });

    it("starts on the first region the reader's languages name", () => {
        expect(phoneCountryFromLocales(["es-ES", "en-US"])).toBe("ES");
        expect(phoneCountryFromLocales(["en", "pt-BR"])).toBe("BR");
        expect(phoneCountryFromLocales(["en", "not a tag"])).toBeUndefined();
    });
});

describe("phoneField", () => {
    it("stores a valid number in E.164", () => {
        expect(phoneField.parse(" +34 600 11 12 22 ")).toBe(SPAIN);
    });

    it("refuses a well-shaped number that cannot exist", () => {
        expect(phoneShapeField.safeParse("+3460011122").success).toBe(true);
        expect(phoneField.safeParse("+3460011122").success).toBe(false);
    });
});

describe("defaultPhoneCountry", () => {
    it("trusts the country the server placed the request in first", () => {
        expect(defaultPhoneCountry({ server: "pt", locales: ["es-ES"], timeZone: "Europe/Madrid" })).toBe("PT");
    });

    it("falls back to the region of the reader's languages", () => {
        expect(defaultPhoneCountry({ server: null, locales: ["en", "es-MX"], timeZone: "Europe/Madrid" })).toBe("MX");
    });

    it("skips a server code that is no country", () => {
        expect(defaultPhoneCountry({ server: "XX", locales: ["fr-FR"] })).toBe("FR");
    });

    it("then uses the time zone, and only one that names a single country", () => {
        expect(defaultPhoneCountry({ locales: ["es"], timeZone: "Europe/Madrid" })).toBe("ES");
        expect(defaultPhoneCountry({ locales: ["es"], timeZone: "Etc/UTC" })).toBe("US");
    });

    it("ends on the neutral default, or the one given", () => {
        expect(defaultPhoneCountry({})).toBe("US");
        expect(defaultPhoneCountry({}, "GB")).toBe("GB");
    });
});
