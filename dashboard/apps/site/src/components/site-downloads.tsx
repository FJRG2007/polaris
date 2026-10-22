"use client";

/**
 * The dashboard's Downloads page, the same components, fed with what the site
 * build read: the dashboard's own catalogs and the same release lookup. With
 * no signed-in reader, each slot shows what the dashboard shows somebody who
 * has nothing yet - no connected decks, the browser's own install menu - and
 * links to screens inside Polaris are drawn as words.
 */

import type { ReactNode } from "react";
import type { DownloadsData } from "@/data/builders";
import type { Locale, Namespaces } from "@polaris/core";
import { I18nContext, useTranslations } from "@polaris/ui/i18n";
import { AppHrefProvider } from "@polaris/ui/account-downloads/app-link";
import { DeckCard, DeckFile } from "@polaris/ui/account-downloads/deck-card";
import { DownloadsPage } from "@polaris/ui/account-downloads/downloads-page";
import {
    DesktopFilesOffer,
    ExtensionFilesOffer
} from "@polaris/ui/account-downloads/app-download-offers";

/** Where Polaris will answer once it is installed: a placeholder, as fixture text. */
const EXAMPLE_ADDRESS = "https://polaris.example.com";

const nowhere = () => null;

function BrowserInstall() {
    const t = useTranslations("components");
    return <p className="text-sm text-muted-foreground">{t("installApp.fromMenu")}</p>;
}

function Messages({
    locale,
    messages,
    children
}: {
    locale: Locale;
    messages: Namespaces;
    children: ReactNode;
}) {
    return <I18nContext.Provider value={{ locale, messages }}>{children}</I18nContext.Provider>;
}

export function SiteDownloads({
    locale,
    repo,
    data
}: {
    locale: "en" | "es";
    repo: string;
    data: DownloadsData;
}) {
    const { files } = data;
    return (
        <Messages
            locale={locale === "es" ? "es-ES" : "en-US"}
            messages={data.messages[locale] as unknown as Namespaces}
        >
            <AppHrefProvider value={nowhere}>
                <DownloadsPage
                    repo={repo}
                    serverUrl={EXAMPLE_ADDRESS}
                    webApp={<BrowserInstall />}
                    extensionFiles={<ExtensionFilesOffer download={files.extension} />}
                    deck={
                        <DeckCard
                            address={EXAMPLE_ADDRESS}
                            repo={repo}
                            storeUrl={data.storeUrl}
                            pluginFile={
                                <DeckFile download={files.streamdeck} suffix=".streamDeckPlugin" />
                            }
                            moduleFile={<DeckFile download={files.companion} suffix=".tgz" />}
                        />
                    }
                    desktopFiles={<DesktopFilesOffer download={files.desktop} />}
                />
            </AppHrefProvider>
        </Messages>
    );
}
