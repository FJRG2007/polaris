/**
 * The deployment's languages as a picker lists them: each in its own name, and
 * the ones not fully translated yet marked as such, so nobody picks one
 * expecting every screen in it.
 */

import type { LanguageChoice } from "@polaris/ui";
import { isCompleteLocale, LOCALE_INFO, LOCALES } from "@polaris/core";

/** `partial` is the reader's word for "partially translated". */
export function localeChoices(partial: string): LanguageChoice[] {
    return LOCALES.map((locale) => ({
        value: locale,
        tag: locale,
        label: LOCALE_INFO[locale].name,
        ...(isCompleteLocale(locale) ? {} : { note: partial })
    }));
}
