/**
 * Every language Translate offers, as the shared language picker lists them:
 * each in itself with its flag and the screen's name for it, sorted by the
 * name in itself, and found by the English name and the code too.
 */

import { useMemo } from "react";
import { LANGUAGE_CODES } from "../model/languages";
import { languageListName, languageOptions, type SearchableSelectOption } from "@polaris/ui";

export function useLanguageOptions(locale: string): SearchableSelectOption[] {
    return useMemo(
        () =>
            languageOptions(
                LANGUAGE_CODES.map((code) => ({
                    value: code,
                    tag: code,
                    label: languageListName(code, code)
                })),
                locale
            ).sort((a, b) => String(a.label).localeCompare(String(b.label), locale)),
        [locale]
    );
}
