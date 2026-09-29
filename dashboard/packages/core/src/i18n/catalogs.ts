/**
 * A set of catalogs - every namespace, in every locale - and the translators
 * over it.
 *
 * The dashboard builds one from `apps/web/messages`, and an installed app builds
 * its own from the `messages/` it ships: the same function, so an app's strings
 * are typed, checked and formatted exactly like the dashboard's without the app
 * importing a line of the dashboard.
 */

import { LOCALES, type Locale } from "./locales.js";
import {
    createTranslator,
    formatMessage,
    lookupMessage,
    type Catalog,
    type CatalogShape,
    type MessageKey,
    type MessageParams,
    type Translator
} from "./messages.js";

/** The locale whose catalogs define the keys: every other one must match it. */
export const SOURCE_LOCALE = LOCALES[0];

/** Namespaces by name, for one locale. */
export type Namespaces = Readonly<Record<string, Catalog>>;

/** A namespace-qualified key: `"account.language.title"`. */
export type QualifiedKey<T extends Namespaces> = {
    [N in keyof T & string]: `${N}.${MessageKey<T[N]>}`;
}[keyof T & string];

/** The source locale's namespaces as they are, and every other locale's in the
 *  same shape - a missing key in a translation is a type error. */
export type LocaleCatalogs<T extends Namespaces> = { readonly [SOURCE in typeof SOURCE_LOCALE]: T } & {
    readonly [L in Exclude<Locale, typeof SOURCE_LOCALE>]: CatalogShape<T>;
};

export interface CatalogSet<T extends Namespaces> {
    readonly catalogs: LocaleCatalogs<T>;
    /** Every namespace name the set has. */
    readonly namespaces: readonly (keyof T & string)[];
    /** A translator over one namespace in one locale, kept once built. */
    translator<N extends keyof T & string>(locale: Locale, namespace: N): Translator<MessageKey<T[N]>>;
    /** One message by its qualified key, with no translator in hand - for a
     *  notification, an email, a line sent into a game. */
    translate(locale: Locale, key: QualifiedKey<T>, params?: MessageParams): string;
    /** The namespaces a screen asked for, in one locale: what a server hands the
     *  browser, which never receives the rest. */
    pick(locale: Locale, namespaces: readonly (keyof T & string)[]): Namespaces;
}

/** Build the set. Called once per catalog owner, at module level. */
export function defineCatalogs<T extends Namespaces>(catalogs: LocaleCatalogs<T>): CatalogSet<T> {
    const source = catalogs[SOURCE_LOCALE];
    const namespaces = Object.keys(source) as (keyof T & string)[];
    const translators = new Map<string, unknown>();

    function namespaceOf(locale: Locale, namespace: string): Catalog | undefined {
        return (catalogs[locale] as Namespaces | undefined)?.[namespace];
    }

    function translator<N extends keyof T & string>(locale: Locale, namespace: N): Translator<MessageKey<T[N]>> {
        const id = `${locale}:${namespace}`;
        let found = translators.get(id);
        if (!found) {
            found = createTranslator(locale, namespaceOf(locale, namespace), { namespace });
            translators.set(id, found);
        }
        return found as Translator<MessageKey<T[N]>>;
    }

    function translate(locale: Locale, key: QualifiedKey<T>, params?: MessageParams): string {
        const cut = key.indexOf(".");
        const namespace = key.slice(0, cut);
        const message = lookupMessage(namespaceOf(locale, namespace), key.slice(cut + 1));
        if (message === undefined) return translator(locale, namespace)(key.slice(cut + 1) as never, params);
        return formatMessage(locale, message, params, undefined, key);
    }

    function pick(locale: Locale, wanted: readonly (keyof T & string)[]): Namespaces {
        const picked: Record<string, Catalog> = {};
        for (const namespace of wanted) {
            const catalog = namespaceOf(locale, namespace);
            if (catalog) picked[namespace] = catalog;
        }
        return picked;
    }

    return { catalogs, namespaces, translator, translate, pick };
}
