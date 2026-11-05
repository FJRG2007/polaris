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
import { I18nContext } from "@polaris/ui/i18n";
import { Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setActionFailureText } from "@/lib/run-action";
import { useRouterSettled } from "@/components/use-router-settled";
import {
    clientFacts,
    createTranslator,
    DEFAULT_LOCALE,
    negotiateLocale,
    type Client,
    type ClientFacts,
    type Locale,
    type Namespaces
} from "@polaris/core";
import { desktopBridge } from "@/lib/desktop-bridge";

/** The locale and the first namespaces, for everything below. Pure, so a test
 *  can render a translated component inside one without a router. */
export function I18nProvider({
    locale,
    messages,
    client: served = "browser",
    children
}: {
    locale: Locale;
    messages: Namespaces;
    /** Which Polaris the request came from, as the server read it. */
    client?: Client;
    children: ReactNode;
}) {
    const client = useSettledClient(served);
    const value = useMemo(() => ({ locale, messages, client }), [locale, messages, client]);
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
            selectSearch: t("ui.selectSearch"),
            selectEmpty: t("ui.selectEmpty"),
            selectMore: (hidden) => t("ui.selectMore", { hidden }),
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
    // The redraw waits until the router has arrived: a refresh while a page's
    // redirect is still being carried out crashes the tab (see useRouterSettled).
    const settled = useRouterSettled();
    useEffect(() => {
        document.documentElement.lang = locale;
        const remembered = readLocaleCookie(document.cookie);
        if (signedIn) {
            if (remembered !== locale) writeLocaleCookie(locale);
            return;
        }
        // The rest can end in a redraw, so it waits; nothing above it can.
        if (!settled) return;
        if (remembered) return;
        const preferred = negotiateLocale(navigator.languages);
        if (!preferred) return;
        writeLocaleCookie(preferred);
        // Only when the cookie took: with cookies refused, the server would draw
        // the same page again and this would ask again, for ever.
        if (preferred !== locale && readLocaleCookie(document.cookie) === preferred)
            router.refresh();
    }, [locale, signedIn, router, settled]);
    return null;
}

/**
 * More namespaces for the screens below, on top of the ones above. Rendered by
 * the `<Messages>` server component rather than directly.
 */
export function MessagesProvider({
    messages,
    children
}: {
    messages: Namespaces;
    children: ReactNode;
}) {
    const parent = useContext(I18nContext);
    const value = useMemo(
        () => ({
            locale: parent?.locale ?? DEFAULT_LOCALE,
            messages: { ...parent?.messages, ...messages },
            client: parent?.client
        }),
        [parent, messages]
    );
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Whether every one of these namespaces already reached this point of the tree. */
export function useHasMessages(namespaces: readonly string[]): boolean {
    const state = useContext(I18nContext);
    const messages = state?.messages as Record<string, unknown> | undefined;
    return namespaces.every((namespace) => messages?.[namespace] !== undefined);
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
                namespace,
                client: state?.client
            }) as unknown as NamespaceTranslator<N>,
        [state, namespace]
    );
}

/**
 * The Polaris this page is drawn in - a browser, the desktop app, or the
 * dashboard installed as an app - and what that means for it (see
 * client-surface.ts). The one question every screen asks instead of looking for
 * the desktop bridge or the display mode itself.
 */
export function useClient(): Client {
    return useContext(I18nContext)?.client ?? "browser";
}

export function useClientFacts(): ClientFacts {
    return clientFacts(useClient());
}

/**
 * The server's reading, corrected once the page can see for itself. The server
 * knows the desktop app by its user-agent, so that case paints right the first
 * time; an app installed from the browser sends the browser's user-agent, and
 * only the display mode tells it apart, so it is worded as a browser for the
 * first paint and as the app straight after.
 */
function useSettledClient(served: Client): Client {
    const [client, setClient] = useState<Client>(served);
    useEffect(() => {
        if (desktopBridge()) setClient("desktop");
        else if (
            served === "browser" &&
            window.matchMedia?.("(display-mode: standalone)").matches
        ) {
            setClient("installed");
        } else setClient(served);
    }, [served]);
    return client;
}
