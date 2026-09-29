"use client";

/**
 * Shortcut to open a UniFi UNAS device's own management console. UniFi exposes
 * two front doors - the cloud portal (unifi.ui.com) and the device's local IP -
 * so this offers both and lets the user pick; both open in a new tab. Rendered
 * only for unifi-unas connections that resolved a local URL.
 */

import { Cloud, ExternalLink, Router } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

const UNIFI_CLOUD_URL = "https://unifi.ui.com";

export function UnifiConsoleButton({ webUrl }: { webUrl?: string }) {
    const t = useTranslations("drive");
    function open(url: string) {
        window.open(url, "_blank", "noopener,noreferrer");
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary">
                    <ExternalLink className="size-4" />
                    {t("unifi.openConsole")}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t("unifi.openTheUnifiConsole")}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => open(UNIFI_CLOUD_URL)}>
                    <Cloud className="size-4 text-muted-foreground" />
                    {t("unifi.unifiCloudUnifiUiCom")}
                </DropdownMenuItem>
                {webUrl ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => open(webUrl)}>
                            <Router className="size-4 text-muted-foreground" />
                            {t("unifi.thisDevice", { address: webUrl.replace(/^https?:\/\//, "") })}
                        </DropdownMenuItem>
                    </>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
