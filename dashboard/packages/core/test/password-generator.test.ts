/**
 * What a generated password has to be true of.
 *
 * Two of these are the ones that matter. A password must honour what was asked
 * for - the minimums especially, because a form that demands a digit and a
 * generator that sometimes omits one is a generator people stop trusting. And the
 * draw must not favour the front of the alphabet, which is what taking a
 * remainder of a random number does and what nobody would ever notice by looking
 * at the output.
 */

import { describe, expect, it } from "vitest";
import {
    generatePassword,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH
} from "../src/password-generator";

const runs = (count: number, make: () => string | null): string[] =>
    Array.from({ length: count }, make).filter((one): one is string => one !== null);

describe("making up a password", () => {
    it("is as long as it was asked to be", () => {
        for (const length of [8, 16, 20, 64, PASSWORD_MAX_LENGTH]) {
            expect(generatePassword({ length })?.length).toBe(length);
        }
    });

    it("uses only what it was allowed to use", () => {
        const only = generatePassword({ length: 40, uppercase: false, digits: false, symbols: false, minDigits: 0, minSymbols: 0 });
        expect(only).toMatch(/^[a-z]+$/);
    });

    it("honours the minimums every single time", () => {
        // The one that has to hold over many runs rather than once: a generator
        // that meets a minimum most of the time is the one that fails on the
        // afternoon somebody is filling in a form that demands it.
        for (const password of runs(300, () => generatePassword({ length: 12, minDigits: 3, minSymbols: 2 }))) {
            expect((password.match(/[0-9]/g) ?? []).length).toBeGreaterThanOrEqual(3);
            expect((password.match(/[!#$%&*+\-=?@^_]/g) ?? []).length).toBeGreaterThanOrEqual(2);
        }
    });

    it("refuses what cannot be made rather than bending it", () => {
        // Contradictions somebody typed, not states to paper over.
        expect(generatePassword({ length: 8, minDigits: 5, minSymbols: 5 })).toBeNull();
        expect(generatePassword({ length: PASSWORD_MIN_LENGTH - 1 })).toBeNull();
        expect(generatePassword({ length: PASSWORD_MAX_LENGTH + 1 })).toBeNull();
        expect(
            generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false })
        ).toBeNull();
    });

    it("leaves out the characters people misread when asked to", () => {
        for (const password of runs(50, () => generatePassword({ length: 64, avoidAmbiguous: true }))) {
            expect(password).not.toMatch(/[lIOo01]/);
        }
    });

    it("does not favour the front of the alphabet", () => {
        // The bias a remainder introduces, which is invisible in any one password.
        // Lowercase only, so each of 26 letters should appear about 1/26 of the
        // time; a modulo-biased draw pushes the first letters measurably up. The
        // bound is loose enough not to flake and tight enough to catch it.
        const sample = runs(200, () => generatePassword({ length: 64, uppercase: false, digits: false, symbols: false, minDigits: 0, minSymbols: 0 })).join("");
        const counts = new Map<string, number>();
        for (const character of sample) counts.set(character, (counts.get(character) ?? 0) + 1);

        expect(counts.size).toBe(26);
        const expected = sample.length / 26;
        for (const [, seen] of counts) {
            expect(seen).toBeGreaterThan(expected * 0.7);
            expect(seen).toBeLessThan(expected * 1.3);
        }
    });

    it("does not hand back the same password twice", () => {
        const made = runs(200, () => generatePassword({ length: 20 }));
        expect(new Set(made).size).toBe(made.length);
    });
});
