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
import { Monitor, Smartphone } from "lucide-react";
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
    /** The browser's install offer, drawn in the desktop card as the other way. */
    webApp: ReactNode;
    extensionFiles: ReactNode;
    /** The Stream Deck card. */
    deck: ReactNode;
    desktopFiles: ReactNode;
    /** The TV card, where this page can offer it. */
    tv?: ReactNode;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("components");
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
                        browser's install offer, which needs no download. */}
                    <div id="app" className="flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3">
                        <p className="text-xs font-medium text-muted-foreground">
                            {t("downloads.web.title")}
                        </p>
                        <p className="text-sm text-muted-foreground">{tc("installApp.intro")}</p>
                        {webApp}
                    </div>
                </DownloadCard>

                <ExtensionCard repo={repo} files={extensionFiles} />

                {deck}

                <CliSection repo={repo} serverUrl={serverUrl} />

                <AssistantsCard />

                {tv}

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
