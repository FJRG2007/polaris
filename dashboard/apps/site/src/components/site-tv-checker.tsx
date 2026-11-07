"use client";

/**
 * "Does it work on my TV?" on the site: the dashboard's own checker and its
 * words, with the guides opening as the docs pages beside it. A docs search
 * result for a model lands here with `?q=` holding it, which fills the search.
 * The themes and add-ons gallery below it reads the same words.
 */

import { I18nContext } from "@polaris/ui/i18n";
import type { Locale, Namespaces } from "@polaris/core";
import { useEffect, useState, type ReactNode } from "react";
import { TvGallery, type TvGalleryItem } from "@polaris/ui/tv-gallery";
import { TV_GUIDE_SLUGS, TvChecker, TvPrivacyGuide, type TvGuide } from "@polaris/ui/tv-checker";

function TvWords({
    locale,
    messages,
    children
}: {
    locale: "en" | "es";
    messages: Record<string, unknown>;
    children: ReactNode;
}) {
    const full: Locale = locale === "es" ? "es-ES" : "en-US";
    return (
        <I18nContext.Provider
            value={{ locale: full, messages: { tvCompat: messages } as Namespaces }}
        >
            {children}
        </I18nContext.Provider>
    );
}

export function SiteTvChecker({
    locale,
    messages,
    view = "checker"
}: {
    locale: "en" | "es";
    messages: Record<string, unknown>;
    view?: "checker" | "privacy";
}) {
    const [query, setQuery] = useState<string | null>(null);
    useEffect(() => {
        setQuery(new URLSearchParams(window.location.search).get("q") ?? "");
    }, []);
    const base = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/${locale}/docs/`;
    const guideHref = (guide: TvGuide) => `${base}${TV_GUIDE_SLUGS[guide]}/`;
    return (
        <TvWords locale={locale} messages={messages}>
            {view === "privacy" ? (
                <TvPrivacyGuide />
            ) : (
                // Drawn again once the address has been read, so a ?q= fills the search.
                <TvChecker key={query ?? ""} initialQuery={query ?? ""} guideHref={guideHref} />
            )}
        </TvWords>
    );
}

/** Every theme and add-on a TV can install, the screenshots served from the site's `tv-gallery/`. */
export function SiteTvGallery({
    locale,
    messages,
    items
}: {
    locale: "en" | "es";
    messages: Record<string, unknown>;
    items: readonly TvGalleryItem[];
}) {
    if (!items.length) return null;
    const base = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/tv-gallery/`;
    return (
        <TvWords locale={locale} messages={messages}>
            <TvGallery items={items} screenshotSrc={(item) => `${base}${item.screenshot}`} />
        </TvWords>
    );
}
