"use client";

/**
 * What kind of key is being made: an API key, built by the form below, or a
 * one-time key that adds a router, server or TV to the VPN. Both are listed and
 * revoked on Account > API keys; a VPN key needs the VPN permission, which the
 * server checks when it is made.
 */

import * as ui from "@polaris/ui";
import { useState, type ReactNode } from "react";
import { VpnKeyCreator } from "@/components/vpn/device-keys";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Kind = "api" | "vpn";

export function NewKeyKind({ children, vpn }: { children: ReactNode; vpn: boolean }) {
    const t = useTranslations("account");
    const [kind, setKind] = useState<Kind>("api");
    if (!vpn) return <>{children}</>;
    return (
        <div className="flex flex-col gap-4">
            <ui.SegmentedControl<Kind>
                aria-label={t("apiKeys.kind.label")}
                value={kind}
                onValueChange={setKind}
                options={[
                    { value: "api", label: t("apiKeys.kind.api") },
                    { value: "vpn", label: t("apiKeys.kind.vpn") }
                ]}
            />
            {kind === "api" ? (
                children
            ) : (
                <ui.Card>
                    <ui.CardBody className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">{t("apiKeys.kind.vpnHint")}</p>
                        <VpnKeyCreator withCommand />
                    </ui.CardBody>
                </ui.Card>
            )}
        </div>
    );
}
