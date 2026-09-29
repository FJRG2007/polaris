"use client";

/**
 * The language a page is drawn in, and the messages it was handed, for every
 * client component under it.
 *
 * The root layout provides the locale and the `common` namespace (`I18nProvider`,
 * with `LocaleSync` beside it); a screen that
 * needs more wraps itself in `<Messages namespaces={[...]}>`, which adds them
 * here without replacing what is above. Only what a screen asks for reaches the
 * browser.
 *
 * Switching language is a redraw: the server renders the page again in the new
 * locale (`router.refresh()`), and the new locale and messages arrive here as
 * props. Nothing here fetches a catalog of its own.
 */

import { useRouter } from "next/navigation";
import type { Namespace, NamespaceTranslator } from "@/lib/i18n/types";
import { readLocaleCookie, writeLocaleCookie } from "@/lib/i18n/cookie";
import { UiStringsProvider, type UiStrings } from "@polaris/ui";
import { createContext, Fragment, useContext, useEffect, useMemo, type ReactNode } from "react";
import { setActionFailureText } from "@/lib/run-action";
import { createTranslator, DEFAULT_LOCALE, negotiateLocale, type Locale, type Namespaces } from "@polaris/core";

interface I18nState {
    readonly locale: Locale;
    readonly messages: Namespaces;
}

const I18nContext = createContext<I18nState | null>(null);

/** The locale and the first namespaces, for everything below. Pure, so a test
 *  can render a translated component inside one without a router. */
export function I18nProvider({
    locale,
    messages,
    children
}: {
    locale: Locale;
    messages: Namespaces;
    children: ReactNode;
}) {
    const value = useMemo(() => ({ locale, messages }), [locale, messages]);
    return (
        <I18nContext.Provider value={value}>
            <UiWords>{children}</UiWords>
        </I18nContext.Provider>
    );
}

/** The words `@polaris/ui` draws on its own - a dialog's Cancel, a copy button's
 *  name - from the `components` catalog every page is handed. */
function UiWords({ children }: { children: ReactNode }) {
    const t = useTranslations("components");
    const actionFailed = t("actions.requestFailed");
    useEffect(() => setActionFailureText(actionFailed), [actionFailed]);
    const strings = useMemo<UiStrings>(() => {
        const parts = (said: (string | ReactNode)[]) =>
            said.map((part, index) => <Fragment key={index}>{part}</Fragment>);
        return {
            cancel: t("ui.cancel"),
            deleteTitle: (kind) => t("ui.deleteTitle", { kind }),
            deleteConfirm: (kind) => t("ui.deleteConfirm", { kind }),
            deleteQuestion: (name) => parts(t.rich("ui.deleteQuestion", { name })),
            typeToConfirm: (name) => parts(t.rich("ui.typeToConfirm", { name })),
            copy: t("ui.copy"),
            copyNamed: (label) => t("ui.copyNamed", { label }),
            close: t("ui.close"),
            showPassword: t("ui.showPassword"),
            hidePassword: t("ui.hidePassword"),
            noData: t("ui.noData"),
            noDataInRange: t("ui.noDataInRange"),
            hexColour: t("ui.hexColour"),
            hexOf: (label) => t("ui.hexOf", { label }),
            unit: t("ui.unit"),
            reply: t("ui.reply"),
            send: t("ui.send"),
            sent: t("ui.sent"),
            dismiss: t("ui.dismiss"),
            couldNotSend: t("ui.couldNotSend"),
            didNotWork: t("ui.didNotWork"),
            openNavigation: t("ui.openNavigation"),
            navigation: t("ui.navigation"),
            resetToDefault: t("ui.resetToDefault"),
            resetLayout: t("ui.resetLayout"),
            dns: {
                type: t("ui.dns.type"),
                name: t("ui.dns.name"),
                content: t("ui.dns.content"),
                status: t("ui.dns.status"),
                done: t("ui.dns.done"),
                waiting: t("ui.dns.waiting"),
                conflict: t("ui.dns.conflict"),
                nameOf: (name) => t("ui.dns.nameOf", { name }),
                valueOf: (value) => t("ui.dns.valueOf", { value })
            }
        };
    }, [t]);
    return <UiStringsProvider strings={strings}>{children}</UiStringsProvider>;
}

/**
 * Keeps the document and the cookie agreeing with the locale a page was drawn in.
 *
 * `<html lang>` is set by the server on every full load; a redraw in another
 * language (`router.refresh()`) keeps the element it already had, so it is set
 * here too. With an account, the cookie is made to agree with it, so the
 * sign-in screen after signing out is in the same language. Without one, the
 * browser's own language list gets a say: the server only saw `Accept-Language`,
 * and `navigator.languages` is what the person actually set.
 */
export function LocaleSync({ locale, signedIn }: { locale: Locale; signedIn: boolean }): null {
    const router = useRouter();
    useEffect(() => {
        document.documentElement.lang = locale;
        const remembered = readLocaleCookie(document.cookie);
        if (signedIn) {
            if (remembered !== locale) writeLocaleCookie(locale);
            return;
        }
        if (remembered) return;
        const preferred = negotiateLocale(navigator.languages);
        if (!preferred) return;
        writeLocaleCookie(preferred);
        // Only when the cookie took: with cookies refused, the server would draw
        // the same page again and this would ask again, for ever.
        if (preferred !== locale && readLocaleCookie(document.cookie) === preferred) router.refresh();
    }, [locale, signedIn, router]);
    return null;
}

/**
 * More namespaces for the screens below, on top of the ones above. Rendered by
 * the `<Messages>` server component rather than directly.
 */
export function MessagesProvider({ messages, children }: { messages: Namespaces; children: ReactNode }) {
    const parent = useContext(I18nContext);
    const value = useMemo(
        () => ({
            locale: parent?.locale ?? DEFAULT_LOCALE,
            messages: { ...parent?.messages, ...messages }
        }),
        [parent, messages]
    );
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The locale this page is drawn in. */
export function useLocale(): Locale {
    return useContext(I18nContext)?.locale ?? DEFAULT_LOCALE;
}

/**
 * A translator over one namespace, for a client component:
 *
 *     const t = useTranslations("account");
 *     <h1>{t("preferences.title")}</h1>
 *
 * The namespace has to have been provided above - by the root layout
 * (`common`), the app frame (`nav`) or a `<Messages>` around the screen. A key
 * that is not there is drawn as the key and reported, which the catalog tests
 * turn into a failed build before anybody sees it.
 */
export function useTranslations<N extends Namespace>(namespace: N): NamespaceTranslator<N> {
    const state = useContext(I18nContext);
    return useMemo(
        () =>
            createTranslator(state?.locale ?? DEFAULT_LOCALE, state?.messages[namespace], {
                namespace
            }) as unknown as NamespaceTranslator<N>,
        [state, namespace]
    );
}
