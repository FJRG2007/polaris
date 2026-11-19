"use client";

/**
 * Downloads: the page, card by card, as the dashboard and the public site both
 * draw it. What only one of them can fill - the browser's own install offer,
 * the decks on an account, files looked up per request - comes in as slots, so
 * the layout, the cards, the steps and the previews are one component.
 */

import { Badge } from "../../index";
import type { ReactNode } from "react";
import { CliSection } from "./cli-section";
import { SystemMark } from "./client-marks";
import { useTranslations } from "../../i18n";
import { ExtensionCard } from "./extension-card";
import { AssistantsCard } from "./assistants-card";
import { Globe, Monitor, Smartphone, Tv } from "lucide-react";
import { DownloadCard, DownloadRow, DownloadRows } from "../download-card";
import { DesktopPreview, PhonePreview, TvPreview } from "./download-previews";

/** The phone system with no app yet; a product name, the same in every language. */
// i18n-ignore system's name
const IOS = "iOS";

export function DownloadsPage({
    repo,
    serverUrl,
    webApp,
    extensionFiles,
    deck,
    desktopFiles,
    mobileFiles,
    tv,
    signedFirefox
}: {
    repo: string;
    /** The address the CLI signs in to, or null for the one the page is on. */
    serverUrl: string | null;
    /**
     * The browser's install offer, drawn as a row of the desktop card. Without
     * one, the row names where the browser keeps its own install entry.
     */
    webApp?: ReactNode;
    extensionFiles: ReactNode;
    /** The Stream Deck card. */
    deck: ReactNode;
    desktopFiles: ReactNode;
    /** Every way to install it on an Android phone (`AndroidFilesOffer`). */
    mobileFiles?: ReactNode;
    /**
     * The TV card, where this page can offer its install. Without one, the card
     * still says what Polaris TV is and what installing it takes.
     */
    tv?: ReactNode;
    /** Where the signed Firefox package is served, when the release has one. */
    signedFirefox?: Promise<string | null>;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("components");
    const compat = useTranslations("tvCompat");
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-[17px] font-semibold tracking-tight">
                    {t("downloads.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("downloads.page.intro")}</p>
            </div>

            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
                {/* First and wide: the app itself. Its files wait on GitHub behind
                    their own boundary, so nothing about the card waits with them. */}
                <DownloadCard
                    id="desktop"
                    tint="slate"
                    className="lg:col-span-2"
                    icon={<Monitor className="size-4 shrink-0" />}
                    title={tc("installApp.title")}
                    description={t("downloads.desktop.description")}
                    side={<DesktopPreview />}
                >
                    <div className="flex min-w-0 flex-col gap-2">
                        <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
                            <span className="min-w-0 truncate">{t("downloads.desktop.app")}</span>
                            <Badge variant="neutral">{t("downloads.desktop.recommended")}</Badge>
                        </p>
                        {desktopFiles}
                    </div>
                    {/* The other way to have it in a window of its own: the
                        browser's install offer, which needs no download. Drawn
                        under the installers and quieter than them, because it is
                        the lesser of the two and says what it lacks. */}
                    <div
                        id="app"
                        className="min-w-0 scroll-mt-4 rounded-lg bg-muted/40 px-3 py-2 text-muted-foreground"
                    >
                        <DownloadRows label={t("downloads.web.title")}>
                            <DownloadRow
                                mark={<Globe className="size-4 shrink-0" />}
                                name={t("downloads.web.name")}
                                detail={tc("installApp.intro")}
                            >
                                <p className="text-xs text-muted-foreground">
                                    {t("downloads.web.lacks")}
                                </p>
                                {webApp ?? (
                                    <p className="text-sm text-muted-foreground">
                                        {tc("installApp.fromMenu")}
                                    </p>
                                )}
                            </DownloadRow>
                        </DownloadRows>
                    </div>
                </DownloadCard>

                {/* Second, right after the computer: the phone is where most
                    people carry Polaris. Android first, the best way to install
                    it at the top; iOS says plainly it is not out yet. */}
                <DownloadCard
                    id="mobile"
                    tint="rose"
                    icon={<Smartphone className="size-4 shrink-0" />}
                    title={t("downloads.mobile.title")}
                    description={t("downloads.mobile.description")}
                    preview={<PhonePreview />}
                >
                    {mobileFiles ?? (
                        <p className="text-sm text-muted-foreground">
                            {t("downloads.mobile.elsewhere")}
                        </p>
                    )}
                    <DownloadRows>
                        <DownloadRow
                            mark={<SystemMark os={IOS} />}
                            name={IOS}
                            action={
                                <Badge variant="neutral">{t("downloads.mobile.planned")}</Badge>
                            }
                        />
                    </DownloadRows>
                </DownloadCard>

                {/* Beside the desktop app, since installing on a set goes through
                    it. Where the page cannot drive that install, the card still
                    says what it is and what it takes, with nothing to press. */}
                {tv ?? (
                    <DownloadCard
                        id="tv"
                        tint="sky"
                        icon={<Tv className="size-4 shrink-0" />}
                        title={t("downloads.tv.title")}
                        description={t("downloads.tv.description")}
                        preview={<TvPreview />}
                    >
                        <p className="text-sm text-muted-foreground">
                            {t("downloads.tv.needsApp")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t("downloads.tv.supported")}
                        </p>
                        <a
                            href="#tv-compatibility"
                            className="self-start text-sm text-primary underline"
                        >
                            {compat("title")}
                        </a>
                    </DownloadCard>
                )}

                <ExtensionCard repo={repo} files={extensionFiles} signedFirefox={signedFirefox} />

                {deck}

                <CliSection repo={repo} serverUrl={serverUrl} />

                <AssistantsCard />
            </div>
        </div>
    );
}
