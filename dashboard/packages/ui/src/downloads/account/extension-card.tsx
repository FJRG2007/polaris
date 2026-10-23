"use client";

/**
 * The browser extension's card on the downloads screen: the store row, plainly
 * not there yet, then one row per browser it loads into, each opening that
 * browser's steps.
 *
 * Every row opens the same three things the card used to hold open: the line
 * that installs it and keeps it current, the files, and the guided steps - with
 * the browser of that row already picked. Firefox gets no line, because the line
 * cannot keep a temporary add-on current and says so itself.
 */

import { AppLink } from "./app-link";
import { Badge } from "../../index";
import { Puzzle } from "lucide-react";
import type { ReactNode } from "react";
import { StepsDialog } from "../steps-dialog";
import { ExtensionSteps } from "./extension-steps";
import { BROWSER_GUIDES } from "./browser-guide";
import { ExtensionCommand } from "./extension-command";
import { ExtensionPreview } from "./download-previews";
import { BrowserMark } from "./client-marks";
import { useTranslations } from "../../i18n";
import { DownloadCard, DownloadRow, DownloadRows } from "../download-card";

export function ExtensionCard({
    repo,
    files
}: {
    /** The GitHub repository this deployment updates from. */
    repo: string;
    /** The release's files, which wait on GitHub in a boundary of their own. */
    files: ReactNode;
}) {
    const t = useTranslations("account");
    return (
        <DownloadCard
            id="extension"
            tint="sky"
            icon={<Puzzle className="size-4 shrink-0" />}
            title={t("downloads.extension.title")}
            description={t("downloads.extension.description")}
            preview={<ExtensionPreview />}
        >
            <DownloadRows>
                <DownloadRow
                    mark={<Puzzle className="size-4 text-muted-foreground" />}
                    name={t("downloads.extension.store")}
                    detail={t("downloads.extension.storeHint")}
                    action={<Badge variant="neutral">{t("downloads.extension.notYet")}</Badge>}
                />
            </DownloadRows>

            <DownloadRows label={t("downloads.extension.loadYourself")}>
                {BROWSER_GUIDES.map((guide) => (
                    <DownloadRow
                        key={guide.id}
                        mark={<BrowserMark browser={guide.label} />}
                        name={guide.label}
                        detail={t(
                            guide.id === "firefox"
                                ? "downloads.extension.rowFirefox"
                                : "downloads.extension.rowChromium"
                        )}
                        action={
                            <StepsDialog
                                label={t("downloads.cards.install")}
                                title={t("downloads.cards.installIn", { name: guide.label })}
                            >
                                {/* First, because it is the only way here that
                                    keeps itself current afterward; the files and
                                    the steps stay under it for doing it by hand. */}
                                {guide.id === "firefox" ? null : <ExtensionCommand repo={repo} />}
                                {files}
                                <ExtensionSteps initial={guide.id} />
                            </StepsDialog>
                        }
                    />
                ))}
            </DownloadRows>

            <p className="text-muted-foreground">
                {t.rich("downloads.extension.alreadyHave", {
                    link: (chunks) => (
                        <AppLink key="link" className="underline" href="/account/extension">
                            {chunks}
                        </AppLink>
                    )
                })}
            </p>
        </DownloadCard>
    );
}
