"use client";

/**
 * "Does it work on my TV?" on the site: the dashboard's own checker and its
 * words, with the guides opening as the docs pages beside it. A docs search
 * result for a model lands here with `?q=` holding it, which fills the search.
 */

import { useEffect, useState } from "react";
import { I18nContext } from "@polaris/ui/i18n";
import type { Locale, Namespaces } from "@polaris/core";
import { TV_GUIDE_SLUGS, TvChecker, TvPrivacyGuide, type TvGuide } from "@polaris/ui/tv-checker";

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
    const full: Locale = locale === "es" ? "es-ES" : "en-US";
    return (
        <I18nContext.Provider
            value={{ locale: full, messages: { tvCompat: messages } as Namespaces }}
        >
            {view === "privacy" ? (
                <TvPrivacyGuide />
            ) : (
                // Drawn again once the address has been read, so a ?q= fills the search.
                <TvChecker key={query ?? ""} initialQuery={query ?? ""} guideHref={guideHref} />
            )}
        </I18nContext.Provider>
    );
}
