"use client";

/**
 * The records of every zone this Polaris's Cloudflare token reaches, edited here
 * rather than in another tab at Cloudflare.
 *
 * Its heading paints at once and the zones are read after; the last list of
 * zones is kept in the tab, so a revisit has its picker and its table on screen
 * before that read returns. With no token there is nothing to edit, and it says
 * where one is connected instead of drawing an empty picker.
 */

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { PageSection } from "@/components/page-section";
import { DnsZoneEditor } from "@/components/dns/dns-zone-editor";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { Button, EmptyState, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { listDnsZonesAction } from "@/app/(app)/account/domains/dns-actions";

type Zone = { id: string; name: string };

/** Where the zone list is kept, and how old a kept one may be and still paint. */
const ZONES_KEY = "admin.dnsZones";
const ZONES_MAX_AGE_MS = 24 * 3_600_000;

export function DnsRecordsCard() {
    const t = useTranslations("admin");
    const [zones, setZones] = useState<Zone[] | null>(null);
    const [zoneId, setZoneId] = useState("");
    const [error, setError] = useState("");
    // Bumped by "Try again", which is what re-runs the read below.
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let live = true;
        const adopt = (next: Zone[]) => {
            setZones(next);
            setZoneId((current) => (next.some((zone) => zone.id === current) ? current : (next[0]?.id ?? "")));
        };
        // Read from an effect rather than the first render: the page is rendered on
        // the server too, where the tab's copy does not exist.
        const kept = readSnapshot<Zone[]>(ZONES_KEY, ZONES_MAX_AGE_MS);
        if (kept) adopt(kept.value);
        void listDnsZonesAction()
            .catch(() => ({ error: t("domains.records.readFailed"), zones: undefined }))
            .then((result) => {
                if (!live) return;
                if (result.zones) {
                    writeSnapshot(ZONES_KEY, result.zones);
                    adopt(result.zones);
                    setError("");
                } else setError(result.error ?? t("domains.records.readFailed"));
            });
        return () => {
            live = false;
        };
    }, [attempt]);

    return (
        <PageSection
            id="dns-records"
            wide
            title={t("domains.records.title")}
            description={t("domains.records.description")}
            actions={
                zones && zones.length > 1 ? (
                    <Select
                        value={zoneId}
                        onValueChange={setZoneId}
                        options={zones.map((zone) => ({ value: zone.id, label: zone.name }))}
                        className="w-full sm:w-64"
                        aria-label={t("domains.records.zone")}
                    />
                ) : null
            }
        >
            {error && !zones ? (
                <div className="flex flex-col items-start gap-2">
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            setError("");
                            setAttempt((count) => count + 1);
                        }}
                    >
                        <RefreshCw className="size-4" /> {t("domains.tryAgain")}
                    </Button>
                </div>
            ) : zones === null ? (
                // The table's chrome with its rows pulsing: which zone it is for is
                // the only thing still on its way.
                <DnsZoneEditor scope={null} />
            ) : zones.length === 0 ? (
                <EmptyState
                    title={t("domains.records.emptyTitle")}
                    description={t("domains.records.emptyDescription")}
                    action={
                        <Button asChild size="sm" variant="secondary">
                            <Link href="/admin/integrations">{t("domains.records.openIntegrations")}</Link>
                        </Button>
                    }
                />
            ) : zoneId ? (
                <DnsZoneEditor key={zoneId} scope={{ kind: "instance", zoneId }} />
            ) : null}
        </PageSection>
    );
}
