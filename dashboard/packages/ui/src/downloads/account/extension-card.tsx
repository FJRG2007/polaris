"use client";

/**
 * The browser extension's card on the downloads screen: which browser, then how
 * - from the store, or by hand with a download or a command.
 *
 * The browser starts on the one the page is open in and stays a picker, because
 * the reader may be setting it up for another. The way starts on the store once
 * there is a listing; until then it is shown and cannot be chosen, and the
 * command is the default, being the only way here that keeps itself current.
 * Firefox has no command: the line cannot keep a temporary add-on current.
 */

import { useState } from "react";
import { AppLink } from "./app-link";
import { Puzzle } from "lucide-react";
import type { ReactNode } from "react";
import { BrowserMark } from "./client-marks";
import { useTranslations } from "../../i18n";
import { BROWSER_GUIDES, type BrowserId } from "./browser-guide";
import { ExtensionCommand } from "./extension-command";
import { ExtensionPreview } from "./download-previews";
import { DownloadCard } from "../download-card";
import { SegmentedControl, Select } from "../../index";
import { ExtensionSteps, useBrowserChoice } from "./extension-steps";

/** The ways to install it. */
type Way = "store" | "download" | "command";

/** Where it starts for a browser, when the reader has not chosen. */
function defaultWay(browser: BrowserId, store: boolean): Way {
    if (store) return "store";
    return browser === "firefox" ? "download" : "command";
}

export function ExtensionCard({
    repo,
    files,
    storeUrl = null
}: {
    /** The GitHub repository this deployment updates from. */
    repo: string;
    /** The release's files, which wait on GitHub in a boundary of their own. */
    files: ReactNode;
    /** The store listing, once there is one. */
    storeUrl?: string | null;
}) {
    const t = useTranslations("account");
    const [browser, setBrowser] = useBrowserChoice();
    const [chosen, setChosen] = useState<Way | null>(null);
    const firefox = browser === "firefox";
    // A choice that this browser cannot take falls back to its default.
    const way =
        chosen && !(chosen === "command" && firefox) && !(chosen === "store" && !storeUrl)
            ? chosen
            : defaultWay(browser, Boolean(storeUrl));

    return (
        <DownloadCard
            id="extension"
            tint="sky"
            icon={<Puzzle className="size-4 shrink-0" />}
            title={t("downloads.extension.title")}
            description={t("downloads.extension.description")}
            preview={<ExtensionPreview />}
        >
            <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        className="w-44"
                        value={browser}
                        aria-label={t("downloads.steps.whichBrowser")}
                        onValueChange={(value) => setBrowser(value as BrowserId)}
                        options={BROWSER_GUIDES.map((entry) => ({
                            value: entry.id,
                            label: entry.label,
                            icon: <BrowserMark browser={entry.label} />
                        }))}
                    />
                    <SegmentedControl<Way>
                        aria-label={t("downloads.extension.how")}
                        value={way}
                        onValueChange={setChosen}
                        options={[
                            {
                                value: "store",
                                label: t("downloads.extension.wayStore"),
                                disabled: !storeUrl,
                                title: storeUrl ? undefined : t("downloads.extension.notYet")
                            },
                            { value: "download", label: t("downloads.extension.wayDownload") },
                            {
                                value: "command",
                                label: t("downloads.extension.wayCommand"),
                                disabled: firefox,
                                title: firefox ? t("downloads.extension.rowFirefox") : undefined
                            }
                        ]}
                    />
                </div>

                {way === "store" && storeUrl ? (
                    <a className="underline" href={storeUrl} target="_blank" rel="noreferrer">
                        {t("downloads.extension.store")}
                    </a>
                ) : way === "command" ? (
                    <ExtensionCommand repo={repo} />
                ) : (
                    <>
                        {files}
                        {/* Keyed on the browser so the steps start on it. */}
                        <ExtensionSteps key={browser} initial={browser} picker={false} />
                    </>
                )}
                {!storeUrl ? (
                    <p className="text-xs text-muted-foreground">
                        {t("downloads.extension.storeHint")}
                    </p>
                ) : null}
            </div>

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
