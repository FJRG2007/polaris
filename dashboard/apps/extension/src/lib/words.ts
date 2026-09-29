/**
 * The words the extension says, in the reader's language.
 *
 * The language is the connected account's, as its Polaris last said - the same
 * choice the dashboard honours - and the browser's own where no account is
 * connected yet, or where the server is too old to say. Anything else falls
 * back to English, the language every message is written in first.
 *
 * One catalog per language under `src/messages`, read through the translator the
 * dashboard uses (`@polaris/core`), so plurals and the rest read the same
 * everywhere. Pure: the stored language is read by `lib/locale-store.ts`, which
 * only the entrypoints import, so every module here can be tested without a
 * browser and handed the words it should speak.
 */

import {
    createTranslator,
    DEFAULT_LOCALE,
    isLocale,
    negotiateLocale,
    type Locale,
    type MessageKey,
    type Translator
} from "@polaris/core";
import english from "@/messages/en-US.json";
import spanish from "@/messages/es-ES.json";

export type Catalog = typeof english;
export type WordKey = MessageKey<Catalog>;
export type Words = Translator<WordKey>;

const CATALOGS: Readonly<Record<Locale, Catalog>> = { "en-US": english, "es-ES": spanish };

/** The browser's own language, as the closest one the extension speaks. */
export function browserLocale(): Locale {
    const tags: string[] = [];
    try {
        const ui = typeof browser !== "undefined" ? browser.i18n?.getUILanguage?.() : undefined;
        if (ui) tags.push(ui);
    } catch {
        // No i18n namespace here (a test, an old engine): the page's own list says.
    }
    if (typeof navigator !== "undefined") {
        tags.push(...(navigator.languages ?? []));
        if (navigator.language) tags.push(navigator.language);
    }
    return negotiateLocale(tags) ?? DEFAULT_LOCALE;
}

/** The account's language when it named one the extension speaks, and the
 *  browser's otherwise. */
export function pickLocale(account: unknown): Locale {
    return isLocale(account) ? account : browserLocale();
}

/** The words for one language. */
export function wordsIn(locale: Locale): Words {
    return createTranslator(locale, CATALOGS[locale]);
}

/** English, for a caller that has no reader to ask - and for the tests that
 *  hold a module to what it said before it had a catalog. */
export const ENGLISH: Words = wordsIn(DEFAULT_LOCALE);
