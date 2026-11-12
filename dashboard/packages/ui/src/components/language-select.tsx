"use client";

/**
 * A language picker that is typed down: every language is found by its own
 * name, its English name, the reader's name for it and its code, with or
 * without accents ("espanol" finds "Español").
 */

import { useMemo } from "react";
import {
    SearchableSelect,
    type SearchableSelectOption,
    type SearchableSelectProps
} from "./searchable-select";

export interface LanguageChoice {
    /** What the picker reports when this language is chosen. */
    value: string;
    /** The BCP 47 tag the names are looked up by (`es-ES`, `pt`). */
    tag: string;
    /** The row's text; the language's name in itself when left out. */
    label?: string;
}

/** A language's name in another language, or the tag when the runtime has no name for it. */
export function languageName(tag: string, inLocale: string): string {
    try {
        return new Intl.DisplayNames([inLocale], { type: "language" }).of(tag) ?? tag;
    } catch {
        return tag;
    }
}

/** Text with its accents dropped, so a plain keyboard still finds it. */
function folded(text: string): string {
    return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** The picker's rows: the label shown, and every name it can be typed as. */
export function languageOptions(
    languages: readonly LanguageChoice[],
    readerLocale?: string
): SearchableSelectOption[] {
    return languages.map(({ value, tag, label }) => {
        const own = label ?? languageName(tag, tag);
        const names = [own, languageName(tag, tag), languageName(tag, "en")];
        if (readerLocale) names.push(languageName(tag, readerLocale));
        names.push(tag);
        const keywords = [...new Set([...names, ...names.map(folded)])].join(" ");
        return { value, label: own, keywords };
    });
}

export type LanguageSelectProps = Omit<SearchableSelectProps, "options"> & {
    languages: readonly LanguageChoice[];
    /** The language the page is read in, whose names for the others are also searched. */
    readerLocale?: string;
};

export function LanguageSelect({ languages, readerLocale, ...props }: LanguageSelectProps) {
    const options = useMemo(
        () => languageOptions(languages, readerLocale),
        [languages, readerLocale]
    );
    return <SearchableSelect {...props} options={options} />;
}
