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
import { DesktopPreview, PhonePreview } from "./download-previews";

/** The phone systems the mobile card names; product names, the same in every language. */
// i18n-ignore systems' names
const MOBILE_SYSTEMS = ["iOS", "Android"] as const;

export function DownloadsPage({
    repo,
    serverUrl,
    webApp,
    extensionFiles,
    deck,
    desktopFiles,
    tv
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
    /**
     * The TV card, where this page can offer its install. Without one, the card
     * still says what Polaris TV is and what installing it takes.
     */
    tv?: ReactNode;
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
                    {desktopFiles}
                    {/* The other way to have it in a window of its own: the
                        browser's install offer, which needs no download - a row
                        of this card rather than a card of its own. */}
                    <div id="app" className="min-w-0 scroll-mt-4">
                        <DownloadRows label={t("downloads.web.title")}>
                            <DownloadRow
                                mark={<Globe className="size-4 shrink-0" />}
                                name={t("downloads.web.name")}
                                detail={tc("installApp.intro")}
                            >
                                {webApp ?? (
                                    <p className="text-sm text-muted-foreground">
                                        {tc("installApp.fromMenu")}
                                    </p>
                                )}
                            </DownloadRow>
                        </DownloadRows>
                    </div>
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

                <ExtensionCard repo={repo} files={extensionFiles} />

                {deck}

                <CliSection repo={repo} serverUrl={serverUrl} />

                <AssistantsCard />

                {/* Present, unlinked and honest. A real plan with nothing built,
                    and saying so is the only thing that can be said about it - a
                    disabled button implies a file that is nearly ready, which
                    would be a different and untrue statement. */}
                <DownloadCard
                    id="mobile"
                    tint="rose"
                    icon={<Smartphone className="size-4 shrink-0" />}
                    title={t("downloads.later.mobile")}
                    description={t("downloads.later.mobileHint")}
                    preview={<PhonePreview />}
                >
                    <DownloadRows label={t("downloads.later.title")}>
                        {MOBILE_SYSTEMS.map((os) => (
                            <DownloadRow
                                key={os}
                                mark={<SystemMark os={os} />}
                                name={os}
                                action={
                                    <Badge variant="neutral">{t("downloads.mobile.planned")}</Badge>
                                }
                            />
                        ))}
                    </DownloadRows>
                </DownloadCard>
            </div>
        </div>
    );
}
