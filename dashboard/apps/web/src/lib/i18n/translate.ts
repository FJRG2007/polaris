/**
 * Translation with a locale in hand and no request around it.
 *
 * For code that is not drawing the current reader's screen: a notification
 * written for somebody else, an email, a job. `translate(locale, key, params)`
 * is pure - same locale, key and params, same text - and needs nothing but the
 * locale, which `getUserLocale(userId)` answers for any account.
 *
 * Server-only in practice: it holds every catalog. A screen translates through
 * `getTranslations` (server) or `useTranslations` (client) instead.
 */

import { webCatalogs } from "../../../messages";
import type { Namespace, NamespaceTranslator, WebKey } from "./types";
import { logMissingMessage, withFallback } from "./fallback";
import {
    SOURCE_LOCALE,
    type Client,
    type Locale,
    type MessageParams,
    type Namespaces,
    type Translator
} from "@polaris/core";

/** One message by its qualified key: `translate("es-ES", "nav.account.signOut")`. */
export function translate(locale: Locale, key: WebKey, params?: MessageParams): string {
    return webCatalogs.translate(locale, key, params);
}

/** A translator over one namespace, for code that says several things. */
export function translatorFor<N extends Namespace>(
    locale: Locale,
    namespace: N,
    client?: Client
): NamespaceTranslator<N> {
    const own = webCatalogs.translator(locale, namespace, client) as unknown as Translator;
    const fallback =
        locale === SOURCE_LOCALE
            ? undefined
            : (webCatalogs.translator(SOURCE_LOCALE, namespace, client) as unknown as Translator);
    return withFallback(own, fallback, (key) =>
        missed(namespace, key)
    ) as unknown as NamespaceTranslator<N>;
}

function missed(namespace: string, key: string): void {
    logMissingMessage(`${namespace}.${key}`, "server");
}

/** The namespaces a screen needs, as the browser is handed them. */
export function pickMessages(locale: Locale, namespaces: readonly Namespace[]): Namespaces {
    return webCatalogs.pick(locale, namespaces);
}
