/**
 * The phone domain's golden-vector corpus (plan 4.1): every country's example
 * number from libphonenumber-js, written every way a person types or stores it
 * (E.164, national, with the national prefix, with an international prefix,
 * grouped, keystroke by keystroke), plus empty, whitespace, Unicode digits,
 * extensions, `tel:` URIs, huge and malformed input and the names
 * `Object.prototype` carries. In the files `null` stands for `undefined`, in
 * arguments and in results.
 */

import { createRequire } from "node:module";
import * as phone from "../../src/domains/phone/ts";

const SOURCE = "dashboard/packages/core-rs/src/domains/phone/ts.ts";
const examples = createRequire(import.meta.url)("libphonenumber-js/examples.mobile.json") as Record<string, string>;
const utf16 = (...units: number[]) => ({ $utf16: units });

type Fn = (...args: never[]) => unknown;

/** A phone function as the vector files see it: `null` in for `undefined`, and out. */
export function asVector(fn: (...args: never[]) => unknown): Fn {
    return ((...args: unknown[]) => {
        const result = (fn as (...a: unknown[]) => unknown)(...args.map((a) => (a === null ? undefined : a)));
        return result === undefined ? null : result;
    }) as Fn;
}

export const PHONE_TWINS: Record<string, Fn> = {
    phoneCountries: asVector(phone.phoneCountries),
    isPhoneCountry: asVector(phone.isPhoneCountry),
    phoneCallingCode: asVector(phone.phoneCallingCode),
    phoneMainCountry: asVector(phone.phoneMainCountry),
    toE164: asVector(phone.toE164),
    phoneCountryOf: asVector(phone.phoneCountryOf),
    splitPhone: asVector(phone.splitPhone),
    formatPhoneAsTyped: asVector(phone.formatPhoneAsTyped),
    formatPhoneInternational: asVector(phone.formatPhoneInternational),
    phoneCountryFromLocales: asVector(phone.phoneCountryFromLocales)
};

/**
 * libphonenumber-js keeps `lastIndex` on its two `phone-context` patterns
 * (created with the `g` flag), so a number with a valid context changes how
 * the next one is read. One context that matches neither pattern clears both;
 * every replay of a file starts from that state, in TypeScript and in Rust.
 */
export const PHONE_RESET_INPUT = "tel:1;phone-context=!";

const COUNTRIES = phone.phoneCountries();
const PROTOTYPE_NAMES = [
    "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__",
    "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString"
];
const ODD_COUNTRIES = [null, "", "es", "Es", "XX", "ZZ", "001", "US ", "UK", "EU", ...PROTOTYPE_NAMES];

const fullwidth = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
const arabic = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const persian = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
const grouped = (s: string) => s.replace(/(\d{3})(?=\d)/g, "$1 ");
const dashed = (s: string) => s.replace(/(\d{2})(?=\d)/g, "$1-");

/** Free-form inputs that are not tied to one country. */
const ODD_VALUES: unknown[] = [
    "", " ", "\t\n", " ", "﻿", "　", "+", "++", "+ ", "+0", "+00", "+1", "+12", "+123", "0", "00", "000", "1", "12", "123",
    "abc", "+abc", "phone", "+34 6OO 111 222", "(555) 555-5555", "555-5555", "1-800-FLOWERS", "+1 (202) 555-0123", "+1 202 555 0123 x45",
    "+1 202 555 0123 ext. 45", "+1 202 555 0123 ext 45", "+1 202 555 0123 #45", "+1 202 555 0123;ext=45", "+44 20 7946 0958 extension 9",
    "+34 600 11 12 22 anexo 7", "+7 495 123 45 67 доб 12", "+1 202 555 0123,,45", "tel:+1-202-555-0123", "tel:+34600111222;ext=12",
    "tel:202-555-0123;phone-context=+1", "tel:5550123;phone-context=example.com", "tel:5550123;phone-context=", "+34600111222;isub=12",
    ";phone-context=+44", "+34600111222\n", "\n+34600111222", "+34 600\n111 222", "+34 600 111 222  ", "+3460011122\u0085",
    "+34٦٠٠١١١٢٢٢", "+34۶۰۰۱۱۱۲۲۲", "＋３４６００１１１２２２", "+34 600 111 222 😀", "😀+34600111222", "+34 600-111-222", "+34.600.111.222",
    "+34/600/111/222", "+34 (600) 111 222", "+34 [600] 111 222", "+34~600~111~222", "+34‐600‐111‐222", "+34­600111222",
    "+800 1234 5678", "+808 1234 5678", "+870 301 234 567", "+878 1012 3456 7890 12", "+881 6 1234 5678", "+882 1234 5678", "+883 5100 1234",
    "+888 123 456 789", "+979 1 2345 6789", "+999 123 456", "+0 123 456", "+1234567890123456789", "+12345678901234567890123",
    "0034600111222", "011 44 20 7946 0958", "00 44 20 7946 0958", "8 10 7 495 123 45 67",
    utf16(0x2b, 0x33, 0x34, 0xd800, 0x36, 0x30, 0x30), utf16(0xdc00, 0x2b, 0x31), utf16(0x20, 0xd83d),
    { $repeat: { text: "1", times: 250 } }, { $repeat: { text: "1", times: 251 } }, { $repeat: { text: "+1 202 555 0123 ", times: 40 } },
    { $repeat: { text: "😀", times: 200 } }, { $repeat: { text: " ", times: 300 } }
];

const toE164Cases: { name: string; args: unknown[] }[] = [];
const singleCases: { name: string; args: unknown[] }[] = [];
const typedCases: { name: string; args: unknown[] }[] = [];

for (const value of ODD_VALUES) {
    const label = typeof value === "string" ? JSON.stringify(value).slice(0, 40) : "tagged";
    singleCases.push({ name: `odd ${label}`, args: [value] });
    for (const country of [null, "US", "ES", "GB", "DE", "RU", "IN", "BR"]) {
        toE164Cases.push({ name: `odd ${label} in ${country}`, args: [value, country] });
        typedCases.push({ name: `odd ${label} in ${country}`, args: [value, country] });
    }
}
for (const country of ODD_COUNTRIES) {
    for (const value of ["600111222", "+34600111222", "2025550123", "0"]) {
        toE164Cases.push({ name: `${value} in odd country ${country}`, args: [value, country] });
        typedCases.push({ name: `${value} in odd country ${country}`, args: [value, country] });
    }
}

for (const country of COUNTRIES) {
    const national = examples[country];
    const code = phone.phoneCallingCode(country);
    if (!national) continue;
    const e164 = `+${code}${national}`;
    const forms: [string, string][] = [
        ["E.164", e164],
        ["international grouped", `+${code} ${grouped(national)}`],
        ["international dashed", `+${code}-${dashed(national)}`],
        ["national", national],
        ["national with 0", `0${national}`],
        ["national with 8", `8${national}`],
        ["national with 1", `1${national}`],
        ["with 00", `00${code}${national}`],
        ["with 011", `011${code}${national}`],
        ["code without plus", `${code}${national}`],
        ["fullwidth", fullwidth(e164)],
        ["Arabic-Indic", `+${arabic(code + national)}`],
        ["Persian", `+${persian(code + national)}`],
        ["one digit short", e164.slice(0, -1)],
        ["one digit long", `${e164}5`],
        ["two digits long", `${e164}55`],
        ["with extension", `${e164} ext. 123`],
        ["in text", `call me at ${e164} today`],
        ["padded", `  ${e164}\t`]
    ];
    for (const [form, value] of forms) {
        toE164Cases.push({ name: `${country} ${form}`, args: [value, country] });
        if (form === "national" || form === "E.164" || form === "code without plus")
            toE164Cases.push({ name: `${country} ${form}, no country`, args: [value, null] });
        if (!form.startsWith("national")) singleCases.push({ name: `${country} ${form}`, args: [value] });
    }
    // Keystroke by keystroke, nationally and internationally.
    for (let i = 1; i <= national.length + 1; i++) {
        const typed = `0${national}`.slice(0, i);
        typedCases.push({ name: `${country} national keystroke ${i}`, args: [national.slice(0, i), country] });
        if (i % 2 === 0) typedCases.push({ name: `${country} with 0 keystroke ${i}`, args: [typed, country] });
    }
    for (let i = 1; i <= e164.length; i++) {
        typedCases.push({ name: `${country} international keystroke ${i}`, args: [e164.slice(0, i), i % 3 === 0 ? "US" : null] });
    }
    for (let i = 3; i <= national.length + code.length + 3; i += 3) {
        typedCases.push({ name: `${country} with 00 keystroke ${i}`, args: [`00${code}${national}`.slice(0, i), country] });
        typedCases.push({ name: `${country} with 011 keystroke ${i}`, args: [`011${code}${national}`.slice(0, i), "US"] });
        typedCases.push({ name: `${country} missing plus keystroke ${i}`, args: [`${code}${national}`.slice(0, i), country] });
    }
    typedCases.push({ name: `${country} grouped national`, args: [grouped(national), country] });
    typedCases.push({ name: `${country} fullwidth`, args: [fullwidth(national), country] });
}

const codes = new Set<string>();
for (let i = 0; i < 1000; i++) codes.add(String(i));
for (const extra of ["", "01", "001", "0034", "+34", " 34", "34 ", "1234", "constructor", "__proto__", "toString", "ES", "x"]) codes.add(extra);

export const PHONE_CORPUS = [
    { op: "phoneCountries", cases: [{ name: "every country", args: [] }] },
    {
        op: "isPhoneCountry",
        cases: [...COUNTRIES, ...ODD_COUNTRIES, "AC", "TA", "XK", "AQ", "BV", "eS", "ES\u0000", "ＥＳ"].map((c, i) => ({ name: `code ${i} ${c}`, args: [c] }))
    },
    {
        op: "phoneCallingCode",
        cases: [...COUNTRIES, ...ODD_COUNTRIES.filter((c) => c !== null), "AQ", "ＥＳ"].map((c, i) => ({ name: `country ${i} ${c}`, args: [c] }))
    },
    { op: "phoneMainCountry", cases: [...codes].map((c) => ({ name: `calling code ${JSON.stringify(c)}`, args: [c] })) },
    { op: "toE164", cases: toE164Cases },
    { op: "phoneCountryOf", cases: singleCases },
    { op: "splitPhone", cases: singleCases },
    { op: "formatPhoneAsTyped", cases: typedCases },
    { op: "formatPhoneInternational", cases: singleCases },
    {
        op: "phoneCountryFromLocales",
        cases: [
            [], ["es-ES"], ["es"], ["en-US", "es-ES"], ["en", "fr-CA"], ["zh-Hant-TW"], ["en-us"], ["EN-gb"], ["en-419"], ["es-419", "pt-BR"],
            ["de-DD"], ["en-UK"], ["sr-Latn-RS"], ["x-private"], ["i-klingon"], ["en-GB-oed"], ["", "es-ES"], ["not a tag", "fr-FR"], ["und-AQ"],
            ["und-001"], ["en-001"], ["en-XK"], ["ar-EG-u-nu-arab"], ["ja-JP-u-ca-japanese"], ["en-US-POSIX"], ["root"], ["en_US"], ["es-ES", "es-ES"]
        ].map((locales, i) => ({ name: `locales ${i} ${locales.join(",")}`, args: [locales] }))
    }
].map((entry) => ({ domain: "phone", source: SOURCE, fn: PHONE_TWINS[entry.op]!, ...entry }));
