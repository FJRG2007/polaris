import { describe, expect, it } from "vitest";
import { signInIdentifierForms, signedInAccountFor } from "../src/signed-in-accounts.js";

const ANA = { id: "ana", email: "Ana@Fixture.test", username: "ana_f", phone: "+34600111222" };
const BEN = { id: "ben", email: "ben@fixture.test", username: "123456789", phone: null };
const CAI = { id: "cai", email: "cai@fixture.test", username: null, phone: "+34 611 22 33 44" };
const ON_DEVICE = [ANA, BEN, CAI];

describe("signInIdentifierForms", () => {
    it("reads an address, a username and a phone number", () => {
        expect(signInIdentifierForms("  Ana@Fixture.TEST ")).toEqual({
            email: "ana@fixture.test",
            username: null,
            phone: null
        });
        expect(signInIdentifierForms("Ana_F")).toEqual({
            email: null,
            username: "ana_f",
            phone: null
        });
        expect(signInIdentifierForms("+34 600 11 12 22").phone).toBe("+34600111222");
    });

    it("reads a national number only with a country, and keeps it a username too", () => {
        expect(signInIdentifierForms("600 11 12 22").phone).toBeNull();
        expect(signInIdentifierForms("600 11 12 22", "ES")).toEqual({
            email: null,
            username: "600 11 12 22",
            phone: "+34600111222"
        });
    });

    it("is empty for nothing typed", () => {
        expect(signInIdentifierForms("   ")).toEqual({ email: null, username: null, phone: null });
    });
});

describe("signedInAccountFor", () => {
    it("matches the address regardless of case and spaces", () => {
        expect(signedInAccountFor(" ana@FIXTURE.test", ON_DEVICE)?.id).toBe("ana");
    });

    it("matches the username regardless of case", () => {
        expect(signedInAccountFor("ANA_F", ON_DEVICE)?.id).toBe("ana");
    });

    it("matches a phone however either side was spelled", () => {
        expect(signedInAccountFor("+34600111222", ON_DEVICE)?.id).toBe("ana");
        expect(signedInAccountFor("+34 611-22-33-44", ON_DEVICE)?.id).toBe("cai");
        expect(signedInAccountFor("611 22 33 44", ON_DEVICE, "ES")?.id).toBe("cai");
    });

    it("prefers nothing over a guess: a national number without a country is a username", () => {
        expect(signedInAccountFor("600111222", ON_DEVICE)).toBeNull();
        expect(signedInAccountFor("123456789", ON_DEVICE, "ES")?.id).toBe("ben");
    });

    it("finds nothing for an identifier that is not on the device, or a partial one", () => {
        expect(signedInAccountFor("dan@fixture.test", ON_DEVICE)).toBeNull();
        expect(signedInAccountFor("ana@fixture", ON_DEVICE)).toBeNull();
        expect(signedInAccountFor("ana", ON_DEVICE)).toBeNull();
        expect(signedInAccountFor("", ON_DEVICE)).toBeNull();
        expect(signedInAccountFor("ana@fixture.test", [])).toBeNull();
    });
});

describe("signedInAccountFor with several numbers", () => {
    it("names the account by any of its verified numbers, not only the primary", () => {
        const DEV = { id: "dev", email: "dev@fixture.test", username: null, phone: "+34600999111", phones: ["+34600999111", "+34600999222"] };
        expect(signedInAccountFor("+34 600 999 222", [ANA, DEV])?.id).toBe("dev");
        expect(signedInAccountFor("+34600999333", [ANA, DEV])).toBeNull();
    });
});
