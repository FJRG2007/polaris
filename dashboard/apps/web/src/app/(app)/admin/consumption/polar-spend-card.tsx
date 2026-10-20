"use client";

/**
 * What Polar spent this month on the AI keys this Polaris shares, and who spent
 * it - beside what the machine itself is spending. Read after the screen has
 * painted, from /api/admin/polar-usage.
 */

import Link from "next/link";
import { Card, CardBody, Skeleton } from "@polaris/ui";
import type { SharedKeySpend } from "@/lib/polar/usage";
import { useLiveResource } from "@/components/use-live-resource";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

const POLL_MS = 60_000;

export function PolarSpendCard() {
    const t = useTranslations("admin");
    const locale = useLocale();
    const { data, loading, error } = useLiveResource<SharedKeySpend>({
        url: "/api/admin/polar-usage",
        cacheKey: "admin.polarSpend",
        intervalMs: POLL_MS,
        select: (body) => body as SharedKeySpend
    });

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium">{t("consumption.polar.title")}</span>
                        <span className="text-xs text-muted-foreground">
                            {t("consumption.polar.description")}
                        </span>
                    </div>
                    {data ? (
                        <span className="text-xs text-muted-foreground tabular-nums">
                            {t("consumption.polar.totals", {
                                tokens: formatTokens(data.tokens, locale),
                                cost: formatUsd(data.costUsd, locale),
                                answers: data.answers
                            })}
                        </span>
                    ) : null}
                </div>
                {error ? (
                    <p className="text-sm text-muted-foreground">{t("consumption.polar.failed")}</p>
                ) : loading && !data ? (
                    <Skeleton className="h-16 w-full" />
                ) : !data || data.people.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("consumption.polar.empty")}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[28rem] text-sm">
                            <thead>
                                <tr className="text-left">
                                    <th className="w-full max-w-0 py-1 pr-3">
                                        {t("consumption.polar.person")}
                                    </th>
                                    <th className="py-1 pr-3 text-right">
                                        {t("consumption.polar.answers")}
                                    </th>
                                    <th className="py-1 pr-3 text-right">
                                        {t("consumption.polar.tokens")}
                                    </th>
                                    <th className="py-1 text-right">
                                        {t("consumption.polar.cost")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.people.map((person) => (
                                    <tr key={person.userId} className="border-t border-border">
                                        <td className="max-w-0 py-1 pr-3">
                                            <Link
                                                href={`/admin/users/${person.userId}`}
                                                className="block truncate hover:underline"
                                                title={person.name}
                                            >
                                                {person.name}
                                            </Link>
                                        </td>
                                        <td className="py-1 pr-3 text-right tabular-nums">
                                            {person.answers}
                                        </td>
                                        <td className="py-1 pr-3 text-right tabular-nums">
                                            {formatTokens(person.tokens, locale)}
                                        </td>
                                        <td className="py-1 text-right tabular-nums">
                                            {formatUsd(person.costUsd, locale)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {data && data.unpriced > 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {t("consumption.polar.unpriced", { count: data.unpriced })}
                    </p>
                ) : null}
            </CardBody>
        </Card>
    );
}
