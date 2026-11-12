"use client";

/** A target language, named in the reader's own language and found by any of its names. */

import { useMemo } from "react";
import { LanguageSelect as Picker, languageName } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { TARGET_LANGUAGES } from "@/lib/text-translation/logic";

export function languageLabel(code: string, locale: string): string {
    return languageName(code, locale);
}

export function LanguageSelect({
    value,
    onChange,
    label,
    className
}: {
    value: string;
    onChange: (code: string) => void;
    label: string;
    className?: string;
}) {
    const locale = useLocale();
    const t = useTranslations("common");
    const languages = useMemo(
        () =>
            TARGET_LANGUAGES.map((code) => ({
                value: code,
                tag: code,
                label: languageLabel(code, locale)
            })).sort((one, other) => one.label.localeCompare(other.label, locale)),
        [locale]
    );
    return (
        <Picker
            value={value}
            onValueChange={onChange}
            languages={languages}
            readerLocale={locale}
            searchPlaceholder={t("languagePicker.search")}
            emptyText={t("languagePicker.empty")}
            aria-label={label}
            className={className}
        />
    );
}
