"use client";

/**
 * A language picker that is typed down: every language is found by its own
 * name, its English name, the reader's name for it and its code, with or
 * without accents ("espanol" finds "Español").
 *
 * Each row reads like a language menu people already know: the flag, the
 * language's name in itself, and - muted, at the right - its name in the
 * reader's language when that says something different.
 */

import { useMemo } from "react";
import { LanguageFlag, languageFlagCode } from "./language-flag";
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

/**
 * A language's name as a list row shows it: the region short ("English (UK)")
 * and the first letter capitalized, since some languages write their own name
 * in lower case ("dansk").
 */
export function languageListName(tag: string, inLocale: string): string {
    try {
        const name =
            new Intl.DisplayNames([inLocale], {
                type: "language",
                languageDisplay: "standard",
                style: "short"
            }).of(tag) ?? tag;
        return name.charAt(0).toLocaleUpperCase(inLocale) + name.slice(1);
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
    // A row with no flag keeps an empty slot when others have one, so every
    // name starts at the same place.
    const anyFlag = languages.some(({ tag }) => languageFlagCode(tag) !== null);
    return languages.map(({ value, tag, label }) => {
        const own = label ?? languageListName(tag, tag);
        const theirs = readerLocale ? languageListName(tag, readerLocale) : undefined;
        const names = [own, languageName(tag, tag), languageName(tag, "en")];
        if (readerLocale) names.push(languageName(tag, readerLocale));
        if (theirs) names.push(theirs);
        names.push(tag);
        const keywords = [...new Set([...names, ...names.map(folded)])].join(" ");
        const hint =
            theirs && theirs.toLocaleLowerCase() !== own.toLocaleLowerCase() ? theirs : undefined;
        const icon =
            languageFlagCode(tag) !== null ? (
                <LanguageFlag tag={tag} />
            ) : anyFlag ? (
                <span aria-hidden data-icon-placeholder className="inline-block h-3 w-4 shrink-0" />
            ) : undefined;
        return { value, label: own, keywords, hint, icon };
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
