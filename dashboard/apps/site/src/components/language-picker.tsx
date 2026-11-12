"use client";

/**
 * The site's language, typed down like Polaris's own picker: a language is
 * found by its own name, its English name or its code. Choosing one opens the
 * page being read in that language, not the home page.
 */

import { LanguageSelect } from "@polaris/ui";
import { usePathname, useRouter } from "next/navigation";
import { pathInLocale } from "@/lib/locale-path";
import { SITE_LOCALES, type SiteLocale } from "@/data/builders";

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
