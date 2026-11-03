/**
 * Every language Translate offers, as a picker lists them: named in the
 * screen's language, sorted by that name, and found by the English name and
 * the code too.
 */

import { useMemo } from "react";
import type { SearchableSelectOption } from "@polaris/ui";
import { LANGUAGE_CODES, languageName } from "../model/languages";

export function useLanguageOptions(locale: string): SearchableSelectOption[] {
    return useMemo(
        () =>
            LANGUAGE_CODES.map((code) => ({
                value: code,
                label: languageName(code, locale),
                // Found by its English name and code too, whatever the screen's language.
                keywords: `${languageName(code, "en")} ${code}`
            })).sort((a, b) => String(a.label).localeCompare(String(b.label), locale)),
        [locale]
    );
}
