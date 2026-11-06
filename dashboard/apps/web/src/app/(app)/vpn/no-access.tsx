"use client";

/**
 * What adding a device shows somebody the VPN was not given to: the server
 * refuses their key and registration too (`lib/vpn/service.ts` `mayJoin`).
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import { ShieldOff } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function VpnNoAccess() {
    const t = useTranslations("vpn");
    return (
        <ui.EmptyState
            icon={<ShieldOff />}
            title={t("access.title")}
            description={t("access.body")}
            action={
                <ui.Button asChild size="sm" variant="outline">
                    <Link href="/vpn/devices">{t("access.devices")}</Link>
                </ui.Button>
            }
        />
    );
}
