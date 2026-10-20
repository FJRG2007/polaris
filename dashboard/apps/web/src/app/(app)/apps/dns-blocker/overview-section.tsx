"use client";

/**
 * The Ad blocker's Overview: where it stands, pausing it, what it has been doing,
 * and - until the network uses it - what to type into the router.
 */

import { Loader2, RefreshCw } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    CopyButton,
    Skeleton
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DnsBlockerState } from "@/lib/dns-blocker/service";
import { useDnsBlocker } from "./dns-blocker-context";
import { DnsInsightsCard } from "./dns-insights";
import { RouterDnsGuide, type RouterBrandOption } from "./router-dns-guide";

const STATE_TONE: Record<DnsBlockerState, "success" | "warning" | "danger" | "neutral"> = {
    blocking: "success",
    starting: "neutral",
    off: "neutral",
    portTaken: "warning",
    portHeld: "danger",
    conflict: "danger",
    noAddress: "warning"
};

export function DnsOverviewSection({ brands }: { brands: RouterBrandOption[] }) {
    const t = useTranslations("dnsBlocker");
    const {
        status,
        statusError,
        checking,
        switching,
        stalled,
        engineExists,
        notice,
        saved,
        recheck,
        switchTo,
        adoptRules
    } = useDnsBlocker();
    const state = status?.state;

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader className="flex-row items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <CardTitle className="truncate">{t("status.title")}</CardTitle>
                        {state ? (
                            <Badge variant={stalled ? "danger" : STATE_TONE[state]}>
                                {stalled ? t("states.stalled.label") : t(`states.${state}.label`)}
                            </Badge>
                        ) : null}
                    </div>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={recheck}
                        disabled={checking}
                        aria-label={t("status.check")}
                        title={t("status.check")}
                    >
                        <RefreshCw className={checking ? "animate-spin" : undefined} />
                    </Button>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {status ? (
                        <>
                            <p className="text-sm text-muted-foreground">
                                {t(
                                    stalled ? "states.stalled.body" : `states.${status.state}.body`,
                                    {
                                        address: status.address ?? ""
                                    }
                                )}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {!engineExists ? (
                                    <Button
                                        size="sm"
                                        onClick={() => switchTo(true)}
                                        disabled={switching || state === "noAddress"}
                                    >
                                        {switching ? <Loader2 className="animate-spin" /> : null}
                                        {state === "portTaken"
                                            ? t("actions.retry")
                                            : t("actions.turnOn")}
                                    </Button>
                                ) : null}
                                {state === "portHeld" || state === "conflict" || stalled ? (
                                    <Button
                                        size="sm"
                                        onClick={() => switchTo(true)}
                                        disabled={switching}
                                    >
                                        {switching ? <Loader2 className="animate-spin" /> : null}
                                        {t("actions.retry")}
                                    </Button>
                                ) : null}
                                {engineExists ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => switchTo(false)}
                                        disabled={switching}
                                    >
                                        {t("actions.turnOff")}
                                    </Button>
                                ) : null}
                            </div>
                        </>
                    ) : statusError ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <p role="alert" className="text-sm text-danger">
                                {statusError}
                            </p>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={recheck}
                                disabled={checking}
                            >
                                {t("actions.retry")}
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2" aria-busy="true">
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-8 w-28" />
                        </div>
                    )}
                    {state === "blocking" && status?.address ? (
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="text-sm text-muted-foreground">
                                {t("router.dnsServer")}
                            </span>
                            <code
                                className="truncate rounded bg-muted px-1.5 py-0.5 text-sm"
                                title={status.address}
                            >
                                {status.address}
                            </code>
                            <CopyButton value={status.address} />
                        </div>
                    ) : null}
                    {status?.stale && state === "blocking" ? (
                        <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft p-2">
                            <p className="min-w-0 flex-1 text-sm text-warning-ink">
                                {t("status.stale")}
                            </p>
                            <Button size="sm" onClick={() => switchTo(true)} disabled={switching}>
                                {switching ? <Loader2 className="animate-spin" /> : null}
                                {t("status.apply")}
                            </Button>
                        </div>
                    ) : null}
                    {notice ? (
                        <p
                            role={notice.tone === "error" ? "alert" : "status"}
                            className={
                                notice.tone === "error"
                                    ? "text-sm text-danger"
                                    : "text-sm text-success"
                            }
                        >
                            {notice.text}
                        </p>
                    ) : null}
                </CardBody>
            </Card>
            {state === "blocking" ? (
                <DnsInsightsCard
                    mode="overview"
                    onApplied={recheck}
                    onRules={adoptRules}
                    logDays={saved.logDays}
                    refreshHours={saved.refreshHours}
                />
            ) : null}

            {state !== "blocking" ? (
                <Card>
                    <CardHeader>
                        <CardTitle>{t("router.title")}</CardTitle>
                        <p className="text-xs text-muted-foreground">{t("router.intro")}</p>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="text-sm text-muted-foreground">
                                {t("router.dnsServer")}
                            </span>
                            {status?.address ? (
                                <>
                                    <code
                                        className="truncate rounded bg-muted px-1.5 py-0.5 text-sm"
                                        title={status.address}
                                    >
                                        {status.address}
                                    </code>
                                    <CopyButton value={status.address} />
                                </>
                            ) : status ? (
                                <span className="text-sm">{t("router.noAddress")}</span>
                            ) : (
                                <Skeleton className="h-5 w-28" />
                            )}
                        </div>
                        <RouterDnsGuide
                            address={status?.address ?? null}
                            blocking={false}
                            brands={brands}
                        />
                    </CardBody>
                </Card>
            ) : null}
        </div>
    );
}
