"use client";

/**
 * The site's language, typed down like Polaris's own picker: a language is
 * found by its own name, its English name or its code. Choosing one opens the
 * page being read in that language, not the home page, and is remembered so
 * the browser's own language is not applied over it again.
 */

import { LanguageSelect } from "@polaris/ui";
import { usePathname, useRouter } from "next/navigation";
import { pathInLocale } from "@/lib/locale-path";
import { SITE_LOCALES, type SiteLocale } from "@/data/builders";
import { LOCALE_CHOICE_KEY } from "@/lib/locale-detect";

/** Each language named in itself, as a reader looking for theirs expects it. */
const NAMES: Record<SiteLocale, string> = { en: "English", es: "Español" };
const LANGUAGES = SITE_LOCALES.map((locale) => ({ value: locale, tag: locale, label: NAMES[locale] }));

export function LanguagePicker({
    locale,
    label,
    search,
    empty
}: {
    locale: SiteLocale;
    label: string;
    search: string;
    empty: string;
}) {
    const path = usePathname() ?? "/";
    const router = useRouter();
    return (
        <LanguageSelect
            value={locale}
            onValueChange={(value) => {
                if (value === locale) return;
                // A language picked by hand is the one kept: no page detects
                // another after this (`lib/locale-detect`).
                try {
                    localStorage.setItem(LOCALE_CHOICE_KEY, value);
                } catch {
                    // No storage: the choice holds for this visit only.
                }
                router.push(pathInLocale(path, value as SiteLocale, SITE_LOCALES));
            }}
            languages={LANGUAGES}
            readerLocale={locale}
            searchPlaceholder={search}
            emptyText={empty}
            aria-label={label}
            className="w-32 shrink-0"
        />
    );
}
