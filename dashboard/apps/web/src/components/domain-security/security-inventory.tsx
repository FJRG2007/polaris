"use client";

/**
 * Every domain Polaris knows, with its security grade, for the administrator.
 * A row opens into the full card for that domain.
 *
 * The heading paints at once and the rows follow; the list is kept for half a
 * minute so coming back to the page does not ask again.
 */

import { useEffect, useState } from "react";
import { SecurityBadge } from "./security-badge";
import { PageSection } from "@/components/page-section";
import { Badge, EmptyState, Skeleton } from "@polaris/ui";
import { DomainSecurityPanel } from "./domain-security-panel";
import { ChevronDown, ChevronRight, Globe } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import type { InventoryEntry } from "@/lib/domain-security/service";
import { securityInventoryAction } from "@/app/(app)/account/domains/security-actions";

const CACHE_KEY = "domain-security:inventory";
const SNAPSHOT_MS = 30_000;

export function SecurityInventory() {
    const t = useTranslations("domainSecurity");
    const [domains, setDomains] = useState<InventoryEntry[] | null>(() => readSnapshot<InventoryEntry[]>(CACHE_KEY, SNAPSHOT_MS)?.value ?? null);
    const [error, setError] = useState("");
    const [open, setOpen] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await securityInventoryAction().catch(() => null);
            if (cancelled) return;
            if (result?.domains) {
                setDomains(result.domains);
                writeSnapshot(CACHE_KEY, result.domains);
            } else setError(result?.error ?? t("errors.failed"));
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit
    }, []);

    return (
        <PageSection id="security" wide title={t("title")} description={t("admin.intro")}>
            {error && (
                <p role="alert" className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm">
                    {error}
                </p>
            )}
            {domains === null ? (
                <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("admin.loading")}>
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : domains.length === 0 ? (
                <EmptyState icon={<Globe />} title={t("title")} description={t("admin.empty")} />
            ) : (
                <ul className="flex min-w-0 flex-col rounded-lg border border-border">
                    {domains.map((entry) => {
                        const expanded = open === entry.domain;
                        return (
                            <li key={entry.domain} className="min-w-0 border-t border-border first:border-t-0">
                                <button
                                    type="button"
                                    className="hover:bg-muted/50 flex w-full min-w-0 flex-wrap items-center gap-2 px-3 py-2.5 text-left"
                                    aria-expanded={expanded}
                                    aria-label={t(expanded ? "admin.hide" : "admin.show", { domain: entry.domain })}
                                    onClick={() => setOpen(expanded ? null : entry.domain)}
                                >
                                    {expanded ? (
                                        <ChevronDown className="text-muted-foreground size-4 shrink-0" aria-hidden />
                                    ) : (
                                        <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
                                    )}
                                    <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">{entry.domain}</span>
                                    {/* Under the name on a phone, beside it on a wider screen. */}
                                    <span className="flex w-full flex-wrap items-center gap-1 pl-6 sm:w-auto sm:pl-0">
                                        {entry.sources.map((source) => (
                                            <Badge key={source} variant="neutral">
                                                {t(`admin.sources.${source as "instance"}`)}
                                            </Badge>
                                        ))}
                                        <SecurityBadge grade={entry.grade?.grade ?? "unknown"} problems={entry.grade?.problems} />
                                    </span>
                                </button>
                                {expanded && (
                                    <div className="border-t border-border px-3 py-3">
                                        <DomainSecurityPanel scope={{ kind: "admin" }} domain={entry.domain} />
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </PageSection>
    );
}
