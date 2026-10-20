"use client";

/**
 * How people marked Polar's answers over the last 30 days, and the newest bad
 * marks with what they said was wrong. Read after the screen has painted, from
 * /api/admin/polar-feedback. The answers themselves are never shown here.
 */

import Link from "next/link";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Card, CardBody, Skeleton } from "@polaris/ui";
import { useLiveResource } from "@/components/use-live-resource";
import type { PolarFeedbackSummary } from "@/lib/polar/answer-feedback";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

const POLL_MS = 60_000;

export function PolarFeedbackCard() {
    const t = useTranslations("admin");
    const words = useTranslations("polar");
    const locale = useLocale();
    const { data, loading, error } = useLiveResource<PolarFeedbackSummary>({
        url: "/api/admin/polar-feedback",
        cacheKey: "admin.polarFeedback",
        intervalMs: POLL_MS,
        select: (body) => body as PolarFeedbackSummary
    });

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium">
                            {t("consumption.polarFeedback.title")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {t("consumption.polarFeedback.description")}
                        </span>
                    </div>
                    {data ? (
                        <span className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
                            <span
                                className="flex items-center gap-1"
                                title={t("consumption.polarFeedback.good")}
                            >
                                <ThumbsUp className="size-3.5 shrink-0" aria-hidden />
                                <span className="sr-only">
                                    {t("consumption.polarFeedback.good")}
                                </span>
                                {data.good}
                            </span>
                            <span
                                className="flex items-center gap-1"
                                title={t("consumption.polarFeedback.bad")}
                            >
                                <ThumbsDown className="size-3.5 shrink-0" aria-hidden />
                                <span className="sr-only">
                                    {t("consumption.polarFeedback.bad")}
                                </span>
                                {data.bad}
                            </span>
                        </span>
                    ) : null}
                </div>
                {error ? (
                    <p className="text-sm text-muted-foreground">
                        {t("consumption.polarFeedback.failed")}
                    </p>
                ) : loading && !data ? (
                    <Skeleton className="h-16 w-full" />
                ) : !data || data.recent.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {t("consumption.polarFeedback.empty")}
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border text-sm">
                        {data.recent.map((row) => (
                            <li key={row.id} className="flex min-w-0 flex-col gap-1 py-2">
                                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                                    <Link
                                        href={`/admin/users/${row.userId}`}
                                        className="min-w-0 max-w-full truncate font-medium text-foreground hover:underline"
                                        title={row.name}
                                    >
                                        {row.name}
                                    </Link>
                                    {row.model ? (
                                        <span className="min-w-0 truncate" title={row.model}>
                                            {row.model}
                                        </span>
                                    ) : null}
                                    <time dateTime={row.at} className="tabular-nums">
                                        {new Date(row.at).toLocaleString(locale, {
                                            dateStyle: "medium",
                                            timeStyle: "short"
                                        })}
                                    </time>
                                </div>
                                {row.reasons.length > 0 ? (
                                    <div className="flex flex-wrap gap-1">
                                        {row.reasons.map((reason) => (
                                            <span
                                                key={reason}
                                                className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                                            >
                                                {words(`feedback.reasons.${reason}`)}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                                {row.note ? (
                                    <p className="whitespace-pre-wrap break-words text-sm">
                                        {row.note}
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}
