"use client";

/**
 * The dashboard's Downloads page, the same components, fed with what the site
 * build read: the dashboard's own catalogs and the same release lookup. With
 * no signed-in reader, each slot shows what the dashboard shows somebody who
 * has nothing yet - no connected decks, the browser's own install menu, a TV
 * card with nothing to press - and links to screens inside Polaris are drawn
 * as words. The install menu and the TV card are the shared page's own
 * defaults, drawn when no slot is passed.
 */

import type { ViewerWords } from "@/components/shot-gallery";
import type { ReactNode } from "react";
import type { DownloadsData } from "@/data/builders";
import { EXAMPLE_ORIGIN } from "@/lib/example-origin";
import { useReaderOrigin } from "@/components/example-host";
import { SiteTvChecker, SiteTvGallery } from "@/components/site-tv-checker";
import type { Locale, Namespaces } from "@polaris/core";
import { I18nContext } from "@polaris/ui/i18n";
import { AppHrefProvider } from "@polaris/ui/account-downloads/app-link";
import { DeckCard, DeckFile } from "@polaris/ui/account-downloads/deck-card";
import { DownloadsPage } from "@polaris/ui/account-downloads/downloads-page";
import {
    DesktopFilesOffer,
    ExtensionFilesOffer
} from "@polaris/ui/account-downloads/app-download-offers";

const nowhere = () => null;

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
    data,
    viewer
}: {
    locale: "en" | "es";
    repo: string;
    data: DownloadsData;
    /** The picture viewer's words, for the TV gallery's screenshots. */
    viewer: ViewerWords;
}) {
    const { files } = data;
    const origin = useReaderOrigin() ?? EXAMPLE_ORIGIN;
    return (
        <Messages
            locale={locale === "es" ? "es-ES" : "en-US"}
            messages={data.messages[locale] as unknown as Namespaces}
        >
            <AppHrefProvider value={nowhere}>
                <DownloadsPage
                    repo={repo}
                    serverUrl={origin}
                    extensionFiles={<ExtensionFilesOffer download={files.extension} />}
                    deck={
                        <DeckCard
                            address={origin}
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
            <section
                id="tv-compatibility"
                className="mx-auto mt-10 w-full min-w-0 max-w-6xl scroll-mt-20 px-4"
            >
                <SiteTvChecker locale={locale} messages={data.messages[locale].tvCompat} />
            </section>
            <section
                id="tv-themes-addons"
                className="mx-auto mt-10 w-full min-w-0 max-w-6xl scroll-mt-20 px-4"
            >
                <SiteTvGallery
                    locale={locale}
                    messages={data.messages[locale].tvCompat}
                    items={data.tvGallery ?? []}
                    viewer={viewer}
                />
            </section>
        </Messages>
    );
}
