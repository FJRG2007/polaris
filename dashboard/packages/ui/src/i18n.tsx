"use client";

/**
 * The locale and catalogs a screen is drawn with, shared by the dashboard and
 * the public site. The dashboard's `I18nProvider` fills it from the server;
 * the site fills it with the same catalogs, read at build time. Components in
 * this package that need the dashboard's words read them through here, so the
 * same component draws the same words in both.
 */

import { createContext, useContext, useMemo } from "react";
import { createTranslator, DEFAULT_LOCALE, type Locale, type Namespaces } from "@polaris/core";

export interface I18nState {
    readonly locale: Locale;
    readonly messages: Namespaces;
}

export const I18nContext = createContext<I18nState | null>(null);

/** A translator over one namespace, untyped: the dashboard's typed one wraps it. */
export function useTranslations(namespace: string) {
    const state = useContext(I18nContext);
    return useMemo(
        () =>
            createTranslator(state?.locale ?? DEFAULT_LOCALE, state?.messages[namespace], {
                namespace
            }),
        [state, namespace]
    );
}

export function useLocale(): Locale {
    return useContext(I18nContext)?.locale ?? DEFAULT_LOCALE;
}
