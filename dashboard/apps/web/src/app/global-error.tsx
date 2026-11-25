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
import { useEffect, useMemo, useState } from "react";
import { FONT_CLASSES } from "./fonts";
import { readLocaleCookie } from "@/lib/i18n/cookie";
import { isStaleBuildError, reloadForNewBuild } from "@/lib/stale-build";
import { resetNetworkStreak, useNetworkRetry } from "@/lib/network-retry";
import { reportClientError } from "@/lib/client-error";
import {
    createTranslator,
    DEFAULT_LOCALE,
    mergeCatalog,
    negotiateLocale,
    type Locale,
    type PartialCatalogShape
} from "@polaris/core";

/**
 * This boundary replaces the root layout, and with it the provider every other
 * screen reads its words from. So it carries its own: the `common` catalog of
 * each language, which is small, and the language this browser was last shown
 * Polaris in. Chosen after mount - the server drew this in English, and
 * drawing something else before hydration would not match it.
 */
const COMMON: Readonly<Partial<Record<Locale, PartialCatalogShape<typeof enUS>>>> = {
    "en-US": enUS,
    "es-ES": esES
};

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

/**
 * What was thrown, as an Error. Anything can be thrown - a string, or nothing
 * at all - and this screen reads `.message` off it; a screen that throws while
 * reporting a failure is how the framework's own bare "Application error" page
 * ends up shown in its place.
 */
function asError(thrown: unknown): Error & { digest?: string } {
    if (thrown instanceof Error) return thrown;
    if (thrown && typeof thrown === "object" && typeof (thrown as { message?: unknown }).message === "string")
        return thrown as Error;
    return new Error(thrown === undefined || thrown === null ? "Unknown error" : String(thrown));
}

export default function GlobalError({
    error: thrown,
    reset
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const error = useMemo(() => asError(thrown), [thrown]);
    const staleBuild = isStaleBuildError(error);
    // A request that never reached the server is retried by itself first; the
    // card below speaks only once that ran out, and then about the connection.
    const retried = useNetworkRetry(error, reset);
    const network = staleBuild ? "other" : retried;
    const offline = network === "offline";
    const locale = useReaderLocale();
    // A language with only some of `common` reads English for the rest.
    const t = createTranslator(locale, mergeCatalog(enUS, COMMON[locale]) as typeof enUS, {
        namespace: "common"
    });

    // Logged here and told to the server, so the next one of these has a
    // stack somebody can read without the reader's devtools.
    useEffect(() => {
        console.error(error);
        reportClientError(error, "global");
    }, [error]);

    // A tab that outlived a deploy is holding chunks the server no longer serves.
    // Recovered the same way here as in the dashboard's own boundary: once, and
    // then this screen is shown rather than looping.
    useEffect(() => {
        if (staleBuild) reloadForNewBuild();
    }, [staleBuild]);

    return (
        <html lang="en" dir="ltr" className={FONT_CLASSES} suppressHydrationWarning>
            <body>
                <div className="flex min-h-dvh items-center justify-center safe-p-6">
                    {network === "retrying" ? null : (
                    <div className="flex max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-6">
                        <div className="flex flex-col gap-1">
                            <h1 className="text-sm font-medium">
                                {staleBuild
                                    ? t("pages.globalError.updatedTitle")
                                    : offline
                                      ? t("pages.globalError.offlineTitle")
                                      : t("pages.globalError.brokeTitle")}
                            </h1>
                            <p className="text-sm text-muted-foreground">
                                {staleBuild
                                    ? t("pages.globalError.updatedBody")
                                    : offline
                                      ? t("pages.globalError.offlineBody")
                                      : t("pages.globalError.brokeBody")}
                            </p>
                        </div>
                        {error.message && !staleBuild && !offline ? (
                            <p className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                                {error.message}
                            </p>
                        ) : null}
                        {error.digest && !staleBuild && !offline ? (
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
                                    onClick={() => {
                                        resetNetworkStreak();
                                        reset();
                                    }}
                                    className="w-fit rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
                                >
                                    {t("pages.globalError.tryAgain")}
                                </button>
                            )}
                        </div>
                    </div>
                    )}
                </div>
            </body>
        </html>
    );
}
