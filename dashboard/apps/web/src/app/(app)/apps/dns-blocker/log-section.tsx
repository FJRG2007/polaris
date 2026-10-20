"use client";

/**
 * The Ad blocker's Query log: every lookup with its filters and the live view.
 * A link carries the filter (`?client=`, `?domain=`, `?outcome=`, `?type=`), so
 * the device list and the Overview can open it already narrowed.
 */

import Link from "next/link";
import { DnsInsightsCard } from "./dns-insights";
import { useDnsBlocker } from "./dns-blocker-context";
import { Button, Card, CardBody, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function DnsLogSection() {
    const t = useTranslations("dnsBlocker");
    const { status, saved, recheck, adoptRules } = useDnsBlocker();

    if (status?.state === "blocking")
        return (
            <DnsInsightsCard
                mode="log"
                onApplied={recheck}
                onRules={adoptRules}
                logDays={saved.logDays}
                refreshHours={saved.refreshHours}
            />
        );
    return (
        <Card>
            <CardBody className="flex flex-wrap items-center gap-3">
                {status ? (
                    <>
                        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                            {t("log.off")}
                        </p>
                        <Button asChild size="sm" variant="outline">
                            <Link href="/apps/dns-blocker">{t("log.overview")}</Link>
                        </Button>
                    </>
                ) : (
                    <Skeleton className="h-5 w-2/3" />
                )}
            </CardBody>
        </Card>
    );
}
