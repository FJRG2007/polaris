"use client";

/**
 * A server's cloud firewall, step by step, for the provider it runs on: the
 * provider stays a picker because a server's name is only a hint. The rules
 * themselves are drawn by whoever uses this, under the steps that refer to them.
 */

import { Button, Select } from "@polaris/ui";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useRef, useState } from "react";
import { bold } from "./guide-parts";
import { CLOUD_FIREWALLS, detectCloud, type CloudFirewall } from "@/lib/backup-access/firewall-guide";
import type { NamespaceKey } from "@/lib/i18n/types";

export function CloudFirewallSteps({
    serverName,
    address
}: {
    serverName: string | null;
    address: string;
}) {
    const t = useTranslations("admin");
    const detected = detectCloud(serverName);
    const [cloud, setCloud] = useState<CloudFirewall>(detected);
    // A provider the operator chose outranks the name, as a router's brand does.
    const picked = useRef(false);
    useEffect(() => {
        if (!picked.current) setCloud(detected);
    }, [detected]);
    const guide = CLOUD_FIREWALLS.find((entry) => entry.id === cloud) ?? CLOUD_FIREWALLS[0];

    return (
        <>
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-40 flex-1 flex-col gap-1">
                    {t("domains.backup.firewall.provider")}
                    <Select
                        value={cloud}
                        onValueChange={(value) => {
                            picked.current = true;
                            setCloud(value as CloudFirewall);
                        }}
                        options={CLOUD_FIREWALLS.map((entry) => ({
                            value: entry.id,
                            label: entry.label ?? t("domains.backup.firewall.otherCloud")
                        }))}
                    />
                </label>
                {guide.url ? (
                    <Button size="sm" variant="secondary" asChild>
                        <a href={guide.url} target="_blank" rel="noreferrer noopener">
                            {t("domains.backup.firewall.open", { provider: guide.label ?? "" })}{" "}
                            <ExternalLink className="size-3.5" />
                        </a>
                    </Button>
                ) : null}
            </div>
            <ol className="ml-4 flex list-decimal flex-col gap-2 text-muted-foreground">
                {Array.from({ length: guide.steps }, (_, index) => (
                    <li key={index}>
                        {t.rich(
                            `domains.backup.firewall.clouds.${cloud}.step${index + 1}` as NamespaceKey<"admin">,
                            { address, b: bold }
                        )}
                    </li>
                ))}
            </ol>
        </>
    );
}
