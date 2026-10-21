"use client";

/**
 * Blocking by what Dymo says about a domain: a switch per category, why they do
 * nothing yet when Dymo is not connected, and the domains it flagged, each
 * with Allow and Check again.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw, Search, ShieldCheck } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    Skeleton,
    Switch
} from "@polaris/ui";
import { useDnsBlocker, useField } from "./dns-blocker-context";
import type { ReputationOff } from "@/lib/dns-blocker/reputation";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DNS_REPUTATION_CATEGORIES } from "@/lib/dns-blocker/settings";
import type { FlaggedDomain } from "@/lib/dns-blocker/reputation-service";
import { dnsReputationAction, recheckDnsReputationAction, ruleFromLogAction } from "./actions";

export function DnsReputationCard() {
    const t = useTranslations("dnsBlocker");
    const [reputation, setReputation] = useField("reputation");
    const { adoptRules, saved } = useDnsBlocker();
    const [off, setOff] = useState<ReputationOff | null | undefined>(undefined);
    const [flagged, setFlagged] = useState<FlaggedDomain[] | null>(null);
    const [search, setSearch] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [version, setVersion] = useState(0);

    useEffect(() => {
        let live = true;
        const timer = setTimeout(() => {
            void dnsReputationAction({ search }).then((result) => {
                if (!live) return;
                if (result.error !== undefined) setLoadError(result.error);
                else {
                    setLoadError(null);
                    setOff(result.off);
                    setFlagged(result.flagged);
                }
            });
        }, 250);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [search, version]);

    const disconnected = off === "integrationOff" || off === "noKey";
    const allowed = new Set(saved.allow);

    async function allow(domain: string) {
        setError(null);
        const result = await ruleFromLogAction({ domain, list: "allow" });
        if (result.error !== undefined) setError(result.error);
        else adoptRules(result.settings);
    }

    async function recheck(domain: string) {
        setError(null);
        const result = await recheckDnsReputationAction({ domain });
        if (result.error !== undefined) setError(result.error);
        else setVersion((value) => value + 1);
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("reputation.title")}</CardTitle>
                <p className="text-xs text-muted-foreground">{t("reputation.intro")}</p>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {disconnected ? (
                    <p className="text-sm">
                        {t(`reputation.off.${off}`)}{" "}
                        <Link href="/admin/integrations" className="text-primary underline">
                            {t("reputation.connect")}
                        </Link>
                    </p>
                ) : null}
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-6">
                    {DNS_REPUTATION_CATEGORIES.map((category) => (
                        <label key={category} className="flex items-center gap-2 text-sm">
                            <Switch
                                checked={reputation[category]}
                                disabled={disconnected && !reputation[category]}
                                onChange={(checked: boolean) =>
                                    setReputation({ ...reputation, [category]: checked })
                                }
                            />
                            <span>{t(`reputation.category.${category}`)}</span>
                        </label>
                    ))}
                </div>
                <p className="text-xs text-muted-foreground">{t("reputation.firstVisit")}</p>
                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
                <div className="relative min-w-0">
                    <Search
                        className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                    />
                    <Input
                        className="pl-8"
                        value={search}
                        placeholder={t("reputation.search")}
                        aria-label={t("reputation.search")}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </div>
                {loadError ? (
                    <div role="alert" className="flex min-w-0 items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 text-danger">{loadError}</span>
                        <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => {
                                setLoadError(null);
                                setVersion((value) => value + 1);
                            }}
                        >
                            {t("actions.retry")}
                        </Button>
                    </div>
                ) : flagged === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : flagged.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("reputation.none")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border">
                        {flagged.map((row) => (
                            <li key={row.domain} className="flex min-w-0 items-center gap-2 py-2">
                                <code
                                    className="min-w-0 flex-1 truncate font-mono text-xs"
                                    title={row.domain}
                                >
                                    {row.domain}
                                </code>
                                {DNS_REPUTATION_CATEGORIES.filter((category) => row[category]).map(
                                    (category) => (
                                        <Badge
                                            key={category}
                                            variant="neutral"
                                            className="shrink-0"
                                        >
                                            {t("reputation.logLabel", {
                                                category: t(`reputation.category.${category}`)
                                            })}
                                        </Badge>
                                    )
                                )}
                                {allowed.has(row.domain) ? (
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {t("reputation.allowed")}
                                    </span>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={t("reputation.allow", { domain: row.domain })}
                                        title={t("reputation.allow", { domain: row.domain })}
                                        onClick={() => void allow(row.domain)}
                                    >
                                        <ShieldCheck className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={disconnected}
                                    aria-label={t("reputation.recheck", { domain: row.domain })}
                                    title={t("reputation.recheck", { domain: row.domain })}
                                    onClick={() => void recheck(row.domain)}
                                >
                                    <RefreshCw className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}
