"use client";

/**
 * A language's flag, drawn from SVG rather than an emoji: Windows has no flag
 * emoji and shows two letters instead.
 *
 * A language is not a country, so the flag is only a hint: the region in the
 * tag when it has one (`en-GB`, `pt-BR`), otherwise the country most readers
 * of that language would expect. A language with no clear country, or a region
 * with no vendored flag, gets no flag at all rather than a wrong one.
 */

import { FLAG_LOADERS } from "../flags";
import { CountryFlag } from "./country-flag";

/** The flag a language with no region in its tag is shown with. */
const LANGUAGE_FLAG: Readonly<Record<string, string>> = {
    ar: "sa",
    bg: "bg",
    ca: "es-ct",
    cs: "cz",
    da: "dk",
    de: "de",
    el: "gr",
    // English with no region is read as American English, the one every
    // engine translates into by default.
    en: "us",
    es: "es",
    et: "ee",
    eu: "es-pv",
    fi: "fi",
    fr: "fr",
    gl: "es-ga",
    he: "il",
    hi: "in",
    hu: "hu",
    id: "id",
    it: "it",
    iw: "il",
    ja: "jp",
    ko: "kr",
    lt: "lt",
    lv: "lv",
    nb: "no",
    nl: "nl",
    nn: "no",
    no: "no",
    pl: "pl",
    pt: "pt",
    ro: "ro",
    ru: "ru",
    sk: "sk",
    sl: "si",
    sv: "se",
    th: "th",
    tr: "tr",
    uk: "ua",
    vi: "vn"
};

/** Chinese is told apart by its script, not by a region. */
const SCRIPT_FLAG: Readonly<Record<string, string>> = { Hans: "cn", Hant: "tw" };

/** The flag a BCP 47 tag is shown with (`us`, `es-ct`), or null when none fits. */
export function languageFlagCode(tag: string): string | null {
    let locale: Intl.Locale;
    try {
        locale = new Intl.Locale(tag);
    } catch {
        return null;
    }
    const code = locale.region
        ? locale.region.toLowerCase()
        : locale.language === "zh"
          ? SCRIPT_FLAG[locale.script ?? ""]
          : LANGUAGE_FLAG[locale.language];
    return code && code in FLAG_LOADERS ? code : null;
}

export function LanguageFlag({ tag, className }: { tag: string; className?: string }) {
    return <CountryFlag code={languageFlagCode(tag)} className={className} />;
}
