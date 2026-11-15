"use client";

/**
 * Beats the site's tracker sent that were not recorded over the last 30 days,
 * by cause, each with what it means and where it is changed - the answer to
 * "the tag is on the page, why is nothing showing up".
 */

import { useEffect, useState } from "react";
import type { AnalyticsScope } from "./site-catalog";
import { grouped } from "./analytics-format";
import { getRejectionsAction } from "./actions";
import { useDisplayFormat } from "@/components/display-format";
import type { RejectionSummary } from "@/lib/analytics-rejections";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, CardHeader, CardTitle, Skeleton } from "@polaris/ui";

export function RejectionsCard({ scope, siteId }: { scope: AnalyticsScope; siteId: string }) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const [rows, setRows] = useState<RejectionSummary[] | null>(null);
    const [failure, setFailure] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        setRows(null);
        setFailure(null);
        void getRejectionsAction({ scopeType: scope, scopeId: siteId }).then((result) => {
            if (!live) return;
            if (result.error || !result.rejections) setFailure(result.error ?? t("rejections.failed"));
            else setRows(result.rejections);
        });
        return () => {
            live = false;
        };
    }, [scope, siteId, t]);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("rejections.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">{t("rejections.intro")}</p>
                {failure ? (
                    <p className="text-xs text-danger">{failure}</p>
                ) : rows === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("rejections.none")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border/60">
                        {rows.map((row) => (
                            <li key={row.cause} className="flex min-w-0 items-start justify-between gap-3 py-2">
                                <div className="flex min-w-0 flex-col gap-0.5">
                                    <span className="text-sm font-medium">{t(`rejections.cause.${row.cause}`)}</span>
                                    <span className="text-xs text-muted-foreground">{t(`rejections.hint.${row.cause}`)}</span>
                                </div>
                                <div className="flex shrink-0 flex-col items-end gap-0.5">
                                    <span className="text-sm font-semibold tabular-nums">{grouped(row.count)}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {t("rejections.last", { day: format.date(row.lastDay) })}
                                    </span>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}
