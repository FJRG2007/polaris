/**
 * Facade for the phone domain: the same exports, signatures and errors as
 * `domains/phone/ts.ts`, served by TypeScript or Rust according to the domain's
 * mode. `@polaris/core` re-exports it as its `phone` module, so every caller
 * goes through here without changing an import.
 *
 * Two things stay on the JavaScript side by design, and are not domain logic:
 * `new Intl.Locale(tag).region` (the platform's locale data; Rust receives the
 * regions), and a call whose arguments are outside the declared types (a
 * non-string value, say), which TypeScript answers so its own TypeError, or
 * its tolerance, is what the caller sees.
 */

import { defineOp } from "./runtime";
import * as ts from "./domains/phone/ts";

export type PhoneCountry = ts.PhoneCountry;

const isText = (value: unknown): value is string => typeof value === "string";
const isOptionalText = (value: unknown) => value === undefined || typeof value === "string";
/** A binding answers `null` (napi) or `undefined` (wasm) for "none". */
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export const phoneCountries: () => readonly PhoneCountry[] = defineOp({
    domain: "phone",
    op: "phoneCountries",
    ts: ts.phoneCountries,
    rust: (binding) => binding.phoneCountries() as PhoneCountry[]
});

export const isPhoneCountry = defineOp({
    domain: "phone",
    op: "isPhoneCountry",
    ts: ts.isPhoneCountry,
    rust: (binding, code: string | null | undefined) =>
        code === null || code === undefined || isText(code) ? binding.phoneIsCountry(code) : ts.isPhoneCountry(code)
}) as (code: string | null | undefined) => code is PhoneCountry;

export const phoneCallingCode: (country: PhoneCountry) => string = defineOp({
    domain: "phone",
    op: "phoneCallingCode",
    ts: ts.phoneCallingCode,
    rust: (binding, country: PhoneCountry) =>
        isText(country) ? (orUndefined(binding.phoneCallingCode(country)) as string) : ts.phoneCallingCode(country),
    errors: { Error }
});

export const phoneMainCountry: (callingCode: string) => PhoneCountry | undefined = defineOp({
    domain: "phone",
    op: "phoneMainCountry",
    ts: ts.phoneMainCountry,
    rust: (binding, callingCode: string) =>
        isText(callingCode) ? (orUndefined(binding.phoneMainCountry(callingCode)) as PhoneCountry | undefined) : ts.phoneMainCountry(callingCode)
});

export const toE164: (value: string, country?: PhoneCountry) => string | null = defineOp({
    domain: "phone",
    op: "toE164",
    ts: ts.toE164,
    rust: (binding, value: string, country?: PhoneCountry) =>
        isText(value) && isOptionalText(country) ? (binding.phoneToE164(value, country) ?? null) : ts.toE164(value, country),
    errors: { Error, TypeError }
});

export const phoneCountryOf: (value: string) => PhoneCountry | undefined = defineOp({
    domain: "phone",
    op: "phoneCountryOf",
    ts: ts.phoneCountryOf,
    rust: (binding, value: string) =>
        isText(value) ? (orUndefined(binding.phoneCountryOf(value)) as PhoneCountry | undefined) : ts.phoneCountryOf(value),
    errors: { Error, TypeError }
});

export const splitPhone: (value: string) => { country?: PhoneCountry; national: string } = defineOp({
    domain: "phone",
    op: "splitPhone",
    ts: ts.splitPhone,
    rust: (binding, value: string) => {
        if (!isText(value)) return ts.splitPhone(value);
        const split = binding.phoneSplit(value);
        const national = split.national ?? value.slice(split.start, split.end);
        return split.country ? { country: split.country as PhoneCountry, national } : { national };
    },
    errors: { Error, TypeError }
});

export const formatPhoneAsTyped: (value: string, country?: PhoneCountry) => string = defineOp({
    domain: "phone",
    op: "formatPhoneAsTyped",
    ts: ts.formatPhoneAsTyped,
    rust: (binding, value: string, country?: PhoneCountry) =>
        isText(value) && isOptionalText(country) ? binding.phoneFormatAsTyped(value, country) : ts.formatPhoneAsTyped(value, country),
    errors: { Error, TypeError }
});

export const formatPhoneInternational: (value: string) => string = defineOp({
    domain: "phone",
    op: "formatPhoneInternational",
    ts: ts.formatPhoneInternational,
    rust: (binding, value: string) => (isText(value) ? (binding.phoneFormatInternational(value) ?? value) : ts.formatPhoneInternational(value)),
    errors: { Error, TypeError }
});

function regionOf(tag: string): string | null {
    try {
        return new Intl.Locale(tag).region ?? null;
    } catch {
        // A malformed tag is skipped, as the TypeScript implementation skips it.
        return null;
    }
}

export const phoneCountryFromLocales: (locales: readonly string[]) => PhoneCountry | undefined = defineOp({
    domain: "phone",
    op: "phoneCountryFromLocales",
    ts: ts.phoneCountryFromLocales,
    rust: (binding, locales: readonly string[]) =>
        Array.isArray(locales)
            ? (orUndefined(binding.phoneCountryFromRegions(locales.map(regionOf))) as PhoneCountry | undefined)
            : ts.phoneCountryFromLocales(locales)
});
