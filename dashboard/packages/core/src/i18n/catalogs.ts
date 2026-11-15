/**
 * A set of catalogs - every namespace, in every locale - and the translators
 * over it.
 *
 * The dashboard builds one from `apps/web/messages`, and an installed app builds
 * its own from the `messages/` it ships: the same function, so an app's strings
 * are typed, checked and formatted exactly like the dashboard's without the app
 * importing a line of the dashboard.
 */

import { isCompleteLocale, SOURCE_LOCALE, type CompleteLocale, type Locale } from "./locales.js";
import type { Client } from "../client-surface.js";
import {
    catalogCoverage,
    createTranslator,
    formatMessage,
    lookupMessage,
    mergeCatalog,
    type Catalog,
    type CatalogShape,
    type PartialCatalogShape,
    type MessageKey,
    type MessageParams,
    type Translator
} from "./messages.js";

/** Namespaces by name, for one locale. */
export type Namespaces = Readonly<Record<string, Catalog>>;

/** A namespace-qualified key: `"account.language.title"`. */
export type QualifiedKey<T extends Namespaces> = {
    [N in keyof T & string]: `${N}.${MessageKey<T[N]>}`;
}[keyof T & string];

/** The source locale's namespaces as they are; a complete locale's in the same
 *  shape - a missing key there is a type error - and a partial one's with any of
 *  the source's keys and none of its own (see `LocaleInfo.complete`). */
export type LocaleCatalogs<T extends Namespaces> = {
    readonly [SOURCE in typeof SOURCE_LOCALE]: T;
} & {
    readonly [L in Exclude<CompleteLocale, typeof SOURCE_LOCALE>]: CatalogShape<T>;
} & {
    readonly [L in Exclude<Locale, CompleteLocale>]: PartialCatalogShape<T>;
};

/** How much of one namespace a locale has translated, counted in messages. */
export interface NamespaceCoverage {
    readonly namespace: string;
    readonly translated: number;
    readonly total: number;
}

export interface CatalogSet<T extends Namespaces> {
    readonly catalogs: LocaleCatalogs<T>;
    /** Every namespace name the set has. */
    readonly namespaces: readonly (keyof T & string)[];
    /** A translator over one namespace in one locale, kept once built. `client`
     *  is the Polaris it is read in (see client-surface.ts); a browser when not
     *  given. */
    translator<N extends keyof T & string>(
        locale: Locale,
        namespace: N,
        client?: Client
    ): Translator<MessageKey<T[N]>>;
    /** One message by its qualified key, with no translator in hand - for a
     *  notification, an email, a line sent into a game. */
    translate(locale: Locale, key: QualifiedKey<T>, params?: MessageParams): string;
    /** The namespaces a screen asked for, in one locale: what a server hands the
     *  browser, which never receives the rest. A partial locale's arrive filled
     *  in from the source, so the browser never has a key with no words. */
    pick(locale: Locale, namespaces: readonly (keyof T & string)[]): Namespaces;
    /** Every namespace's coverage in one locale. */
    coverage(locale: Locale): NamespaceCoverage[];
}

/** Build the set. Called once per catalog owner, at module level. */
export function defineCatalogs<T extends Namespaces>(catalogs: LocaleCatalogs<T>): CatalogSet<T> {
    const source = catalogs[SOURCE_LOCALE];
    const namespaces = Object.keys(source) as (keyof T & string)[];
    const translators = new Map<string, unknown>();
    const merged = new Map<string, Catalog | undefined>();

    function ownNamespace(locale: Locale, namespace: string): Catalog | undefined {
        return (catalogs[locale] as Namespaces | undefined)?.[namespace];
    }

    /** A namespace as a reader of the locale gets it: a complete locale's as it
     *  is, a partial one's with the source's message wherever it has none. */
    function namespaceOf(locale: Locale, namespace: string): Catalog | undefined {
        const own = ownNamespace(locale, namespace);
        if (locale === SOURCE_LOCALE || isCompleteLocale(locale)) return own;
        const id = `${locale}:${namespace}`;
        if (!merged.has(id)) {
            const base = (source as Namespaces)[namespace];
            merged.set(id, base ? mergeCatalog(base, own) : own);
        }
        return merged.get(id);
    }

    function translator<N extends keyof T & string>(
        locale: Locale,
        namespace: N,
        client?: Client
    ): Translator<MessageKey<T[N]>> {
        const id = `${locale}:${namespace}:${client ?? ""}`;
        let found = translators.get(id);
        if (!found) {
            found = createTranslator(locale, namespaceOf(locale, namespace), { namespace, client });
            translators.set(id, found);
        }
        return found as Translator<MessageKey<T[N]>>;
    }

    function translate(locale: Locale, key: QualifiedKey<T>, params?: MessageParams): string {
        const cut = key.indexOf(".");
        const namespace = key.slice(0, cut);
        const message = lookupMessage(namespaceOf(locale, namespace), key.slice(cut + 1));
        if (message === undefined)
            return translator(locale, namespace)(key.slice(cut + 1) as never, params);
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

    function coverage(locale: Locale): NamespaceCoverage[] {
        return namespaces.map((namespace) => ({
            namespace,
            ...catalogCoverage(source[namespace]!, ownNamespace(locale, namespace))
        }));
    }

    return { catalogs, namespaces, translator, translate, pick, coverage };
}
