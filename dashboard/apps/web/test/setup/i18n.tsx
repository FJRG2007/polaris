/**
 * Rendering a translated component in a test.
 *
 * A component that calls `useTranslations` reads the namespaces the page
 * handed it; rendered on its own it has none and draws its keys. This hands it
 * every namespace of one locale, the way the root layout and `<Messages>` would.
 *
 *     renderToStaticMarkup(withMessages(<PreferencesForm ... />));
 *     renderToStaticMarkup(withMessages(<PreferencesForm ... />, "es-ES"));
 *     render(<AccountMenu ... />, { wrapper: MessagesWrapper });
 */

import type { ReactNode } from "react";
import type { Locale } from "@polaris/core";
import { webCatalogs } from "../../messages";
import { I18nProvider } from "@/components/i18n/i18n-provider";

export function withMessages(node: ReactNode, locale: Locale = "en-US") {
    return (
        <I18nProvider locale={locale} messages={webCatalogs.pick(locale, webCatalogs.namespaces)}>
            {node}
        </I18nProvider>
    );
}

/** The same, as a testing-library `wrapper`. */
export function MessagesWrapper({ children }: { children: ReactNode }) {
    return withMessages(children);
}
