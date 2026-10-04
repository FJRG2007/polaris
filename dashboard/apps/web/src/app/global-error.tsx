"use client";

/**
 * Last-resort boundary, for a failure in the root layout itself. It replaces the
 * root layout when it renders, so it brings its own document and stylesheets.
 * Only reached when the per-segment boundaries cannot be mounted; everything else
 * is caught closer to where it happened.
 */

import "./globals.css";
import "@polaris/ui/styles.css";
import esES from "../../messages/es-ES/common.json";
import enUS from "../../messages/en-US/common.json";
import { useEffect, useState } from "react";
import { readLocaleCookie } from "@/lib/i18n/cookie";
import { isStaleBuildError, reloadForNewBuild } from "@/lib/stale-build";
import { createTranslator, DEFAULT_LOCALE, negotiateLocale, type Locale } from "@polaris/core";

/**
 * This boundary replaces the root layout, and with it the provider every other
 * screen reads its words from. So it carries its own: the `common` catalog of
 * each language, which is small, and the language this browser was last shown
 * Polaris in. Chosen after mount - the server drew this in English, and
 * drawing something else before hydration would not match it.
 */
const COMMON = { "en-US": enUS, "es-ES": esES } as const satisfies Record<Locale, unknown>;

function useReaderLocale(): Locale {
    const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
    useEffect(() => {
        const chosen =
            readLocaleCookie(document.cookie) ??
            negotiateLocale(navigator.languages) ??
            DEFAULT_LOCALE;
        setLocale(chosen);
        document.documentElement.lang = chosen;
    }, []);
    return locale;
}

export default function GlobalError({
    error,
    reset
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const staleBuild = isStaleBuildError(error);
    const locale = useReaderLocale();
    const t = createTranslator(locale, COMMON[locale] as typeof enUS, { namespace: "common" });

    useEffect(() => {
        console.error(error);
    }, [error]);

    // A tab that outlived a deploy is holding chunks the server no longer serves.
    // Recovered the same way here as in the dashboard's own boundary: once, and
    // then this screen is shown rather than looping.
    useEffect(() => {
        if (staleBuild) reloadForNewBuild();
    }, [staleBuild]);

    return (
        <html lang="en" suppressHydrationWarning>
            <body>
                <div className="flex min-h-dvh items-center justify-center p-6">
                    <div className="flex max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-6">
                        <div className="flex flex-col gap-1">
                            <h1 className="text-sm font-medium">
                                {staleBuild
                                    ? t("pages.globalError.updatedTitle")
                                    : t("pages.globalError.brokeTitle")}
                            </h1>
                            <p className="text-sm text-muted-foreground">
                                {staleBuild
                                    ? t("pages.globalError.updatedBody")
                                    : t("pages.globalError.brokeBody")}
                            </p>
                        </div>
                        {error.message && !staleBuild ? (
                            <p className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                                {error.message}
                            </p>
                        ) : null}
                        {error.digest && !staleBuild ? (
                            <p className="font-mono text-xs text-muted-foreground">
                                {t("pages.globalError.reference", { digest: error.digest })}
                            </p>
                        ) : null}
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => window.location.reload()}
                                className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                            >
                                {t("pages.globalError.reload")}
                            </button>
                            {/* Retrying an old build only reproduces the failure. */}
                            {!staleBuild && (
                                <button
                                    type="button"
                                    onClick={reset}
                                    className="w-fit rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
                                >
                                    {t("pages.globalError.tryAgain")}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </body>
        </html>
    );
}
