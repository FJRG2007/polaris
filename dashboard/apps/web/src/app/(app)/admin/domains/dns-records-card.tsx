"use client";

/**
 * The records of every zone this Polaris's Cloudflare token reaches, edited here
 * rather than in another tab at Cloudflare.
 *
 * Its heading paints at once and the zones are read after. The zone picker reads
 * Cloudflare a page at a time and searches it there, so an account with any
 * number of zones never sends them all; the zone picked last is remembered in
 * this browser, so a revisit opens on it with its table before any read returns.
 * With no token there is nothing to edit, and it says where one is connected
 * instead of drawing an empty picker.
 */

import { RestoreHistoryButton } from "@/components/restore-history";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PageSection } from "@/components/page-section";
import { PagedPicker } from "@/components/paged-picker";
import { DnsZoneEditor } from "@/components/dns/dns-zone-editor";
import { Button, EmptyState } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { dnsZoneOptionsAction } from "@/app/(app)/account/domains/dns-actions";

type Zone = { id: string; name: string };

/** Where the zone picked last is kept, across visits, in this browser. */
const PICKED_KEY = "polaris.admin.dnsZone";

function readPicked(): Zone | null {
    try {
        const parsed = JSON.parse(localStorage.getItem(PICKED_KEY) ?? "null") as Partial<Zone> | null;
        return typeof parsed?.id === "string" && typeof parsed.name === "string"
            ? { id: parsed.id, name: parsed.name }
            : null;
    } catch {
        return null;
    }
}

function writePicked(zone: Zone): void {
    try {
        localStorage.setItem(PICKED_KEY, JSON.stringify(zone));
    } catch {
        // Storage refused (a private window): the pick still holds for this visit.
    }
}

export function DnsRecordsCard() {
    const t = useTranslations("admin");
    const [zone, setZone] = useState<Zone | null>(null);
    // Null until the first page says whether there is any zone, and more than one.
    const [reach, setReach] = useState<"none" | "one" | "many" | null>(null);
    // Bumped after a restore from History, so the editor reads the zone again.
    const [revision, setRevision] = useState(0);
    const [error, setError] = useState("");
    // Bumped by "Try again", which is what re-runs the read below.
    const [attempt, setAttempt] = useState(0);
    const scope = useMemo(() => ({}), []);

    useEffect(() => {
        let live = true;
        // Read from an effect rather than the first render: the page is rendered on
        // the server too, where this browser's storage does not exist.
        const kept = readPicked();
        if (kept) setZone(kept);
        void dnsZoneOptionsAction({ limit: 2 })
            .catch(() => ({ error: t("domains.records.readFailed") }))
            .then((result) => {
                if (!live) return;
                if ("error" in result) {
                    setError(result.error || t("domains.records.readFailed"));
                    return;
                }
                setError("");
                const first = result.items[0];
                setReach(!first ? "none" : result.items.length > 1 || result.next ? "many" : "one");
                if (!kept && first) setZone(first);
                if (!first) setZone(null);
            });
        return () => {
            live = false;
        };
    }, [attempt]);

    function pick(id: string, item: Zone | null) {
        const next = item ?? (zone?.id === id ? zone : null);
        if (!next) return;
        writePicked(next);
        setZone(next);
    }

    return (
        <PageSection
            id="dns-records"
            wide
            title={t("domains.records.title")}
            description={t("domains.records.description")}
            actions={
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    {reach === "many" || (reach === null && zone) ? (
                        <div className="w-full min-w-0 sm:w-64">
                            <PagedPicker<Zone>
                                read={dnsZoneOptionsAction}
                                scope={scope}
                                cache="dns-zones"
                                value={zone?.id ?? null}
                                selectedLabel={zone?.name}
                                onValueChange={pick}
                                placeholder={t("domains.records.zonePlaceholder")}
                                searchPlaceholder={t("domains.records.zoneSearch")}
                                emptyText={t("domains.records.zoneNone")}
                                aria-label={t("domains.records.zone")}
                            />
                        </div>
                    ) : null}
                    {zone ? (
                        <RestoreHistoryButton
                            target={{ kind: "dns", zoneId: zone.id }}
                            canRestore
                            onRestored={() => setRevision((value) => value + 1)}
                        />
                    ) : null}
                </div>
            }
        >
            {error && reach === null && !zone ? (
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
            ) : reach === null && !zone ? (
                // The table's chrome with its rows pulsing: which zone it is for is
                // the only thing still on its way.
                <DnsZoneEditor scope={null} />
            ) : reach === "none" ? (
                <EmptyState
                    title={t("domains.records.emptyTitle")}
                    description={t("domains.records.emptyDescription")}
                    action={
                        <Button asChild size="sm" variant="secondary">
                            <Link href="/admin/integrations">
                                {t("domains.records.openIntegrations")}
                            </Link>
                        </Button>
                    }
                />
            ) : zone ? (
                <DnsZoneEditor key={`${zone.id}:${revision}`} scope={{ kind: "instance", zoneId: zone.id }} />
            ) : null}
        </PageSection>
    );
}
