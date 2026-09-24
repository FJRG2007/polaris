/**
 * What somebody chose for the password generator, kept for next time.
 *
 * One set of choices for the whole browser: the popup's generator writes it and
 * the one offered inside a page reads it, so a site that refuses symbols is told
 * once rather than once per place a password can be made. The generating itself
 * is `@polaris/core`'s; this only decides what to ask it for.
 *
 * Pure on purpose. The value is read out of extension storage, which is an input
 * like any other - it outlives updates, it can hold what an older build wrote, and
 * a profile can be edited by hand - so everything that reads it goes through
 * `readGeneratorOptions`, and a stored value this build does not recognise becomes
 * the defaults rather than a generator that makes nothing.
 */

import {
    PASSWORD_DEFAULTS,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH
} from "@polaris/core/password-generator";

/** Where the choices live: `storage.local`, because they are not a secret and
 *  choosing them again on every browser start would be a chore. */
export const GENERATOR_KEY = "local:generator.options";

/** The choices the popup offers. The minimums are the core's defaults and are
 *  not offered: one of each is what the forms that ask for them ask for. */
export interface GeneratorOptions {
    readonly length: number;
    readonly lowercase: boolean;
    readonly uppercase: boolean;
    readonly digits: boolean;
    readonly symbols: boolean;
    readonly avoidAmbiguous: boolean;
}

/** The four kinds of character, in the order the popup lists them. */
export type CharacterSet = "uppercase" | "lowercase" | "digits" | "symbols";

export const CHARACTER_SETS: readonly CharacterSet[] = [
    "uppercase",
    "lowercase",
    "digits",
    "symbols"
];

export const GENERATOR_DEFAULTS: GeneratorOptions = {
    length: PASSWORD_DEFAULTS.length,
    lowercase: PASSWORD_DEFAULTS.lowercase,
    uppercase: PASSWORD_DEFAULTS.uppercase,
    digits: PASSWORD_DEFAULTS.digits,
    symbols: PASSWORD_DEFAULTS.symbols,
    avoidAmbiguous: PASSWORD_DEFAULTS.avoidAmbiguous === true
};

/** A length the generator will make, from whatever number arrived. */
export function clampLength(value: number): number {
    if (!Number.isFinite(value)) return GENERATOR_DEFAULTS.length;
    return Math.min(PASSWORD_MAX_LENGTH, Math.max(PASSWORD_MIN_LENGTH, Math.round(value)));
}

/**
 * The stored choices as this build can use them.
 *
 * Field by field, so one unreadable field costs that field and not the rest. The
 * one rule across fields is that some kind of character stays on: a stored value
 * with all four off would be a generator that answers every press with nothing.
 */
export function readGeneratorOptions(value: unknown): GeneratorOptions {
    // An array is an object too, and its `length` would be read as the length.
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return GENERATOR_DEFAULTS;
    }
    const held = value as Record<string, unknown>;
    const flag = (name: keyof GeneratorOptions): boolean => {
        const found = held[name];
        return typeof found === "boolean" ? found : (GENERATOR_DEFAULTS[name] as boolean);
    };
    const length = held["length"];
    const read: GeneratorOptions = {
        length: typeof length === "number" ? clampLength(length) : GENERATOR_DEFAULTS.length,
        lowercase: flag("lowercase"),
        uppercase: flag("uppercase"),
        digits: flag("digits"),
        symbols: flag("symbols"),
        avoidAmbiguous: flag("avoidAmbiguous")
    };
    return CHARACTER_SETS.some((set) => read[set]) ? read : { ...read, lowercase: true };
}

/** Whether a set may be switched off: not when it is the only one left on. */
export function canTurnOff(options: GeneratorOptions, set: CharacterSet): boolean {
    return !options[set] || CHARACTER_SETS.some((other) => other !== set && options[other]);
}

/** The choices with one set switched, refusing to switch off the last. */
export function withSet(
    options: GeneratorOptions,
    set: CharacterSet,
    on: boolean
): GeneratorOptions {
    if (!on && !canTurnOff(options, set)) return options;
    return { ...options, [set]: on };
}

/** Whether two sets of choices are the same, so an unchanged one is not written. */
export function sameOptions(left: GeneratorOptions, right: GeneratorOptions): boolean {
    return (
        left.length === right.length &&
        left.avoidAmbiguous === right.avoidAmbiguous &&
        CHARACTER_SETS.every((set) => left[set] === right[set])
    );
}

/**
 * A word for an entropy figure, for the line under the password.
 *
 * The bands are the usual ones for a randomly drawn secret: under 50 bits falls
 * to an offline attack on a stolen hash, 50 to 80 holds against most, and past 80
 * guessing it stops being the weak part of anything.
 */
export function strengthWord(bits: number): "weak" | "fair" | "strong" {
    if (bits < 50) return "weak";
    if (bits < 80) return "fair";
    return "strong";
}
