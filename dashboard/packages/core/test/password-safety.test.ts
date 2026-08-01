/**
 * The rule that stops a password being the account written back at you.
 *
 * The whole point is that it survives the variations people reach for when they
 * are trying to make an obvious password look less obvious: capitals, accents,
 * and punctuation sprinkled through the middle. A check that only compares raw
 * strings passes every one of them, which is worse than having no rule, because
 * it reads as though something was verified.
 */

import { describe, expect, it } from "vitest";
import { normalizeForComparison, passwordMatchesIdentity } from "../src/password-safety.js";

const IDENTITY = ["Francisco Ruiz", "fjrg2007@tpeoficial.com", "fjrg2007", "polaris"];

describe("normalizing for comparison", () => {
    it("makes casing, accents and punctuation stop being differences", () => {
        expect(normalizeForComparison("F.J.R.G_2007")).toBe("fjrg2007");
        expect(normalizeForComparison("José-María")).toBe("josemaria");
        expect(normalizeForComparison("  Polaris!  ")).toBe("polaris");
    });
});

describe("a password built out of the account", () => {
    it("is refused however it is dressed up", () => {
        for (const candidate of ["Fjrg2007", "F.J.R.G_2007", "myfjrg2007pass", "PolarisRules1"]) {
            expect(passwordMatchesIdentity(candidate, IDENTITY)).toBe(true);
        }
    });

    it("is refused when it is the address, or just its local part", () => {
        expect(passwordMatchesIdentity("fjrg2007@tpeoficial.com", IDENTITY)).toBe(true);
        expect(passwordMatchesIdentity("my.fjrg2007.pass", IDENTITY)).toBe(true);
    });

    it("is refused when it is a word out of the display name", () => {
        expect(passwordMatchesIdentity("francisco-rules", IDENTITY)).toBe(true);
    });
});

describe("a password unrelated to the account", () => {
    it("passes", () => {
        for (const candidate of ["correct horse battery staple", "7uKq!vbz#Lm2", "quiet-lantern-drift"]) {
            expect(passwordMatchesIdentity(candidate, IDENTITY)).toBe(false);
        }
    });

    it("does not treat the mail provider as part of the identity", () => {
        // Everybody at a provider shares its domain, so refusing it would refuse a
        // password on a fact about somebody else's mail server.
        expect(passwordMatchesIdentity("tpeoficial-weather-42", ["someone@tpeoficial.com"])).toBe(false);
    });

    it("is not tripped by a short fragment two strings happen to share", () => {
        // "rui" is three characters, below the run that means anything.
        expect(passwordMatchesIdentity("ruinous-weather-42", ["Rui", null, undefined])).toBe(false);
    });

    it("ignores identity values too short to give anything away", () => {
        expect(passwordMatchesIdentity("abcdefghij", ["ab", "", null])).toBe(false);
    });
});
