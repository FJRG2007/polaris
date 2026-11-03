"use client";

/** A target language, named in the reader's own language. */

import { useMemo } from "react";
import { Select } from "@polaris/ui";
import { useLocale } from "@/components/i18n/i18n-provider";
import { TARGET_LANGUAGES } from "@/lib/text-translation/logic";

export function languageLabel(code: string, locale: string): string {
    try {
        return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    } catch {
        return code;
    }
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
    const options = useMemo(
        () =>
            TARGET_LANGUAGES.map((code) => ({ value: code, label: languageLabel(code, locale) })).sort(
                (one, other) => String(one.label).localeCompare(String(other.label), locale)
            ),
        [locale]
    );
    return (
        <Select
            value={value}
            onValueChange={onChange}
            options={options}
            aria-label={label}
            className={className}
        />
    );
}
