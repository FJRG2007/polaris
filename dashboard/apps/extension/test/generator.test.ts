/**
 * The generator's saved choices.
 *
 * Read back out of storage every time the popup opens and every time a page
 * offers a password, so what matters is that nothing stored there - an older
 * build's shape, a hand-edited profile, all four kinds switched off - can turn
 * into a generator that makes nothing.
 */

import { describe, expect, it } from "vitest";
import { generatePassword } from "@polaris/core/password-generator";
import {
    canTurnOff,
    clampLength,
    GENERATOR_DEFAULTS,
    readGeneratorOptions,
    sameOptions,
    strengthWord,
    withSet
} from "../src/lib/generator";

describe("reading the saved choices", () => {
    it("gives the defaults for nothing, or for something that is not a set of choices", () => {
        for (const held of [undefined, null, "20", 20, []]) {
            expect(readGeneratorOptions(held)).toEqual(GENERATOR_DEFAULTS);
        }
    });

    it("keeps what was chosen", () => {
        const chosen = {
            length: 32,
            lowercase: true,
            uppercase: false,
            digits: true,
            symbols: false,
            avoidAmbiguous: true
        };
        expect(readGeneratorOptions(chosen)).toEqual(chosen);
    });

    it("loses only the field it cannot read", () => {
        expect(readGeneratorOptions({ length: "long", symbols: "no", digits: false })).toEqual({
            ...GENERATOR_DEFAULTS,
            digits: false
        });
    });

    it("brings a length back into what the generator makes", () => {
        expect(readGeneratorOptions({ length: 3 }).length).toBe(8);
        expect(readGeneratorOptions({ length: 4096 }).length).toBe(128);
        expect(readGeneratorOptions({ length: Number.NaN }).length).toBe(GENERATOR_DEFAULTS.length);
    });

    it("never hands back all four kinds switched off", () => {
        const read = readGeneratorOptions({
            lowercase: false,
            uppercase: false,
            digits: false,
            symbols: false
        });
        expect(read.lowercase).toBe(true);
        expect(generatePassword(read)).not.toBeNull();
    });
});

describe("switching a kind of character", () => {
    const onlyDigits = {
        ...GENERATOR_DEFAULTS,
        lowercase: false,
        uppercase: false,
        symbols: false
    };

    it("switches one off while another stays on", () => {
        expect(withSet(GENERATOR_DEFAULTS, "symbols", false).symbols).toBe(false);
        expect(canTurnOff(GENERATOR_DEFAULTS, "symbols")).toBe(true);
    });

    it("refuses to switch off the last one", () => {
        expect(canTurnOff(onlyDigits, "digits")).toBe(false);
        expect(withSet(onlyDigits, "digits", false)).toBe(onlyDigits);
    });

    it("always switches one back on", () => {
        expect(withSet(onlyDigits, "symbols", true).symbols).toBe(true);
    });
});

describe("the rest", () => {
    it("clamps a length to the generator's range", () => {
        expect(clampLength(7)).toBe(8);
        expect(clampLength(20.4)).toBe(20);
        expect(clampLength(129)).toBe(128);
        expect(clampLength(Number.POSITIVE_INFINITY)).toBe(GENERATOR_DEFAULTS.length);
    });

    it("tells two identical sets of choices apart from two different ones", () => {
        expect(sameOptions(GENERATOR_DEFAULTS, { ...GENERATOR_DEFAULTS })).toBe(true);
        expect(sameOptions(GENERATOR_DEFAULTS, { ...GENERATOR_DEFAULTS, length: 21 })).toBe(false);
        expect(sameOptions(GENERATOR_DEFAULTS, { ...GENERATOR_DEFAULTS, digits: false })).toBe(
            false
        );
    });

    it("names a strength by the usual bands", () => {
        expect(strengthWord(38)).toBe("weak");
        expect(strengthWord(64)).toBe("fair");
        expect(strengthWord(124)).toBe("strong");
    });
});
