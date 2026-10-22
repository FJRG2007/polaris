"use client";

/**
 * The Stream Deck card of Downloads: the store row, one install guide per host
 * and the plugin's files. What is under it - the decks connected to this
 * account - is the dashboard's, passed in as `children`; the public site has
 * no account and passes nothing.
 */

import type { ReactNode } from "react";
import { Badge, Button } from "../../index";
import { useTranslations } from "../../i18n";
import { StepsDialog } from "../steps-dialog";
import { DeckPreview } from "./download-previews";
import type { AppDownload } from "./app-releases";
import { DownloadWithGuide } from "./download-guide";
import { Download, ExternalLink, Grid3x3 } from "lucide-react";
import { DownloadCard, DownloadRow, DownloadRows } from "../download-card";
import { DECK_HOSTS, DeckHostMark, DeckInstallSteps, HOST_LABELS } from "./deck-install-steps";

/** A release's file ending in `suffix`, or the fact that none has been
 *  published: the plugin's `.streamDeckPlugin` and the Companion module's `.tgz`
 *  share it. */
export function DeckFile({ download, suffix }: { download: AppDownload | null; suffix: string }) {
    const t = useTranslations("account");
    const file = download?.files.find((entry) => entry.name.endsWith(suffix));
    if (download && file) {
        return (
            <div>
                {/* Opens the install guide for the file as its download starts. */}
                <DownloadWithGuide
                    item={suffix === ".tgz" ? "companion" : "streamdeck"}
                    href={file.url}
                    fileName={file.name}
                >
                    <Download className="size-4" />
                    {t("downloads.streamdeck.download", { version: download.version })}
                </DownloadWithGuide>
            </div>
        );
    }
    return (
        <>
            <div>
                <Button variant="secondary" disabled>
                    <Download className="size-4" /> {t("downloads.streamdeck.downloadNone")}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("downloads.streamdeck.notReleased")}</p>
        </>
    );
}

export function DeckCard({
    address,
    repo,
    storeUrl,
    pluginFile,
    moduleFile,
    children
}: {
    /** This Polaris's address for the steps, or null to use the one the page is on. */
    address: string | null;
    /** The repository the plugin's releases and install scripts come from. */
    repo: string;
    /** The Elgato Marketplace listing, once there is one. */
    storeUrl: string | null;
    pluginFile: ReactNode;
    moduleFile: ReactNode;
    children?: ReactNode;
}) {
    const t = useTranslations("account");
    return (
        <DownloadCard
            id="streamdeck"
            tint="amber"
            icon={<Grid3x3 className="size-4 shrink-0" />}
            title={t("downloads.streamdeck.title")}
            description={t("downloads.streamdeck.description")}
            preview={<DeckPreview />}
        >
            {/* The store first, and plainly not there yet until Elgato
                approves the listing - the same row the extension has. */}
            <DownloadRows>
                <DownloadRow
                    mark={<DeckHostMark host="streamdeck" />}
                    name={t("downloads.streamdeck.store")}
                    detail={storeUrl ? undefined : t("downloads.streamdeck.storeHint")}
                    action={
                        storeUrl ? (
                            <Button asChild variant="secondary" size="sm">
                                <a href={storeUrl} target="_blank" rel="noreferrer">
                                    <ExternalLink className="size-4" />
                                    {t("downloads.streamdeck.openStore")}
                                </a>
                            </Button>
                        ) : (
                            <Badge variant="neutral">{t("downloads.extension.notYet")}</Badge>
                        )
                    }
                />
            </DownloadRows>

            <DownloadRows label={t("downloads.streamdeck.installYourself")}>
                {DECK_HOSTS.map((host) => (
                    <DownloadRow
                        key={host}
                        mark={<DeckHostMark host={host} />}
                        name={HOST_LABELS[host]}
                        detail={t(`downloads.streamdeck.hosts.${host}`)}
                        action={
                            <StepsDialog
                                label={t("downloads.cards.install")}
                                title={t("downloads.cards.installIn", { name: HOST_LABELS[host] })}
                            >
                                <DeckInstallSteps
                                    initial={host}
                                    address={address}
                                    repo={repo}
                                    pluginFile={pluginFile}
                                    moduleFile={moduleFile}
                                />
                            </StepsDialog>
                        }
                    />
                ))}
            </DownloadRows>
            {children}
        </DownloadCard>
    );
}
