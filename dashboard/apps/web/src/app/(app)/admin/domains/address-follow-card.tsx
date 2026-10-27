"use client";

/**
 * Whether the domain's own records still name this server's public address.
 *
 * Polaris repoints them by itself every two minutes; this is where an
 * administrator sees what the last pass found, why it could not finish when it
 * could not, and runs it again now instead of waiting for the next one.
 */

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { Button, Skeleton } from "@polaris/ui";
import { PageSection } from "@/components/page-section";
import { RelativeTime } from "@/components/relative-time";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AddressFollowView, FollowStatus } from "@/lib/domain-address-sync";
import { checkPublicAddressAction } from "./actions";

const STATUS_URL = "/api/admin/domains/address-follow";

export function AddressFollowCard() {
    const t = useTranslations("admin");
    const live = useLiveResource<AddressFollowView>({
        url: STATUS_URL,
        cacheKey: "admin.addressFollow",
        intervalMs: 0,
        select: (body) => body as AddressFollowView
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const view = live.data;

    async function check() {
        setBusy(true);
        setError("");
        const result = await runAction(() => checkPublicAddressAction(), setError);
        setBusy(false);
        if (result) live.replace(result);
    }

    if (view && !view.configured) return null;

    return (
        <PageSection
            id="public-address"
            title={t("domains.follow.title")}
            description={t("domains.follow.description")}
            actions={
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void check()}
                    disabled={busy || !view}
                >
                    <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
                    {busy ? t("domains.follow.checking") : t("domains.follow.check")}
                </Button>
            }
        >
            {!view ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-56" />
                    <Skeleton className="h-4 w-72" />
                </div>
            ) : (
                <div className="flex flex-col gap-2 text-sm">
                    {view.status?.checkedAt ? <Facts status={view.status} /> : null}
                    <StatusLine status={view.status} />
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
            )}
        </PageSection>
    );
}

function Facts({ status }: { status: FollowStatus }) {
    const t = useTranslations("admin");
    return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("domains.follow.current")}</dt>
            <dd className="truncate font-mono" title={status.ip ?? undefined}>
                {status.ip ?? "-"}
            </dd>
            <dt className="text-muted-foreground">{t("domains.follow.published")}</dt>
            <dd className="truncate font-mono" title={status.publishedIp ?? undefined}>
                {status.publishedIp ?? "-"}
            </dd>
            <dt className="text-muted-foreground">{t("domains.follow.checked")}</dt>
            <dd className="truncate">
                <RelativeTime iso={status.checkedAt} />
            </dd>
            {status.updatedAt ? (
                <>
                    <dt className="text-muted-foreground">{t("domains.follow.updated")}</dt>
                    <dd className="truncate">
                        <RelativeTime iso={status.updatedAt} />
                        {" - "}
                        {t("domains.follow.updatedCount", { count: status.updatedCount })}
                    </dd>
                </>
            ) : null}
        </dl>
    );
}

function StatusLine({ status }: { status: FollowStatus | null }) {
    const t = useTranslations("admin");
    if (!status?.checkedAt)
        return <p className="text-xs text-muted-foreground">{t("domains.follow.never")}</p>;
    const detail = status.detail ?? "-";
    switch (status.problem) {
        case "no-token":
            return (
                <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                    {t.rich("domains.follow.problem.noToken", {
                        link: (chunks) => (
                            <Link
                                key="link"
                                href="/admin/integrations"
                                className="text-primary hover:underline"
                            >
                                {chunks}
                            </Link>
                        )
                    })}
                </p>
            );
        case "api":
        case "conflict":
        case "failed":
            return (
                <p className="break-words rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                    {t(`domains.follow.problem.${status.problem}`, { detail })}
                </p>
            );
        case "cgnat":
            return (
                <p className="break-words rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                    {t.rich("domains.follow.problem.cgnat", {
                        ip: status.ip ?? "-",
                        link: (chunks) => (
                            <a key="link" href="#backup-access" className="text-primary hover:underline">
                                {chunks}
                            </a>
                        )
                    })}
                </p>
            );
        case "unreached":
            return (
                <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                    {t("domains.follow.problem.unreached")}
                </p>
            );
        default:
            return status.reachBy ? (
                <p className="text-xs text-muted-foreground">{t("domains.follow.propagating")}</p>
            ) : (
                <p className="text-xs text-success">{t("domains.follow.ok")}</p>
            );
    }
}
