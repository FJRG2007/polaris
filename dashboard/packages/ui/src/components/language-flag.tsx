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

import { cn } from "../lib/cn";
import { FLAG_LOADERS } from "../flags";
import { useEffect, useState } from "react";

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

/** Flags already fetched, so a row drawn again shows its flag at once. */
const loaded = new Map<string, string>();

function dataUrl(svg: string): string {
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

export function LanguageFlag({ tag, className }: { tag: string; className?: string }) {
    const code = languageFlagCode(tag);
    const [svg, setSvg] = useState(() => (code ? (loaded.get(code) ?? null) : null));

    useEffect(() => {
        if (!code) return setSvg(null);
        const known = loaded.get(code);
        if (known) return setSvg(known);
        let alive = true;
        setSvg(null);
        FLAG_LOADERS[code]!()
            .then((module) => {
                loaded.set(code, module.default);
                if (alive) setSvg(module.default);
            })
            // A flag that cannot be fetched leaves its slot empty; the name is the answer.
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [code]);

    // No flag fits: a neutral blank of the same size, so a row without one lines
    // up with the rows that have one.
    return (
        <span
            aria-hidden
            data-flag={code ?? "none"}
            data-icon-placeholder={code ? undefined : ""}
            className={cn(
                "inline-block h-3 w-4 shrink-0 rounded-[2px] bg-muted bg-cover bg-center shadow-[0_0_0_1px_rgb(0_0_0/0.08)]",
                className
            )}
            style={svg ? { backgroundImage: dataUrl(svg) } : undefined}
        />
    );
}
