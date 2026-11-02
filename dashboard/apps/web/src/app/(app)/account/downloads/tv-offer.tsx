"use client";

/**
 * The TV card of Downloads. Putting an app on a TV takes a computer on the same
 * network, so the button is the desktop app's; anywhere else the card says that.
 * An app older than the feature has no `openTvInstall` and is told to update.
 */

import { Tv } from "lucide-react";
import { Button } from "@polaris/ui";
import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { desktopBridge } from "@/lib/desktop-bridge";
import { DownloadCard } from "@polaris/ui/download-card";

type Reach = "browser" | "old-app" | "app";

export function TvOffer() {
    const t = useTranslations("account");
    const [reach, setReach] = useState<Reach>("browser");

    useEffect(() => {
        const bridge = desktopBridge();
        if (bridge) setReach(bridge.openTvInstall ? "app" : "old-app");
    }, []);

    return (
        <DownloadCard
            id="tv"
            tint="sky"
            className="lg:col-span-2"
            icon={<Tv className="size-4 shrink-0" />}
            title={t("downloads.tv.title")}
            description={t("downloads.tv.description")}
        >
            {reach === "app" ? (
                <div>
                    <Button onClick={() => void desktopBridge()?.openTvInstall?.()}>
                        {t("downloads.tv.install")}
                    </Button>
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">
                    {reach === "old-app" ? t("downloads.tv.updateApp") : t("downloads.tv.needsApp")}
                </p>
            )}
            <p className="text-xs text-muted-foreground">{t("downloads.tv.supported")}</p>
        </DownloadCard>
    );
}
