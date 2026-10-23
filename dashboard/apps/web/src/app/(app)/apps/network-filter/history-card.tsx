"use client";

/**
 * The Overview's long-term statistics: finished days kept for a year, added up
 * over 30, 90 or 365 days. Each day is rolled up after it ends, so today is in
 * the card above and not here.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle, Select } from "@polaris/ui";
import {
    DNS_HISTORY_RANGE_IDS,
    type DnsHistory,
    type DnsHistoryRange
} from "@/lib/dns-blocker/history";
import * as polls from "./dns-blocker-polls";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    ALLOWED_COLOR,
    BLOCKED_COLOR,
    ChartBlock,
    Figure,
    ShareList,
    TopList,
    listLabel,
    logHref,
    points
} from "./dns-insights";

/** `shared`: read by somebody an administrator shared the statistics with -
 *  no devices, and the rows do not open the log. */
export function DnsHistoryCard({ shared = false }: { shared?: boolean }) {
    const t = useTranslations("dnsBlocker");
    const router = useRouter();
    const [range, setRange] = useState<DnsHistoryRange>("30d");
    const [history, setHistory] = useState<DnsHistory | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        void polls.dnsHistory({ range }).then((result) => {
            if (!live) return;
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            setError(null);
            setHistory(result.history);
        });
        return () => {
            live = false;
        };
    }, [range]);

    const shown = history;
    const empty = shown !== null && shown.queries === 0;

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                    <CardTitle>{t("history.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("history.intro")}</p>
                </div>
                <Select
                    className="w-36"
                    value={range}
                    aria-label={t("insights.range")}
                    onValueChange={(value) => setRange(value as DnsHistoryRange)}
                    options={DNS_HISTORY_RANGE_IDS.map((id) => ({
                        value: id,
                        label: t(`history.ranges.${id}`)
                    }))}
                />
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
                {error ? <p className="text-sm text-danger-ink">{error}</p> : null}
                {empty ? (
                    <p className="text-sm text-muted-foreground">{t("history.empty")}</p>
                ) : (
                    <>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                            <Figure
                                label={t("insights.queries")}
                                value={shown?.queries.toLocaleString()}
                            />
                            <Figure
                                label={t("insights.blocked")}
                                value={shown?.blocked.toLocaleString()}
                            />
                            <Figure
                                label={t("insights.blockedPercent")}
                                value={shown ? `${shown.blockedPercent}%` : undefined}
                            />
                        </div>
                        <ChartBlock
                            title={t("history.perDay")}
                            series={
                                shown
                                    ? [
                                          {
                                              key: "allowed",
                                              label: t("insights.permitted"),
                                              color: ALLOWED_COLOR,
                                              points: points(shown.timeline.allowed, shown.timeline)
                                          },
                                          {
                                              key: "blocked",
                                              label: t("insights.blocked"),
                                              color: BLOCKED_COLOR,
                                              points: points(shown.timeline.blocked, shown.timeline)
                                          }
                                      ]
                                    : null
                            }
                            timeline={shown?.timeline}
                        />
                        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                            <TopList
                                title={t("insights.topPermitted")}
                                items={shown?.topPermitted}
                                empty={t("insights.none")}
                                hint={t("insights.filterDomain")}
                                onPick={
                                    shared
                                        ? undefined
                                        : (search) => router.push(logHref({ search, range: "30d" }))
                                }
                            />
                            <TopList
                                title={t("insights.topBlocked")}
                                items={shown?.topBlocked}
                                empty={t("insights.none")}
                                hint={t("insights.filterDomain")}
                                onPick={
                                    shared
                                        ? undefined
                                        : (search) =>
                                              router.push(
                                                  logHref({ search, outcome: "blocked", range: "30d" })
                                              )
                                }
                            />
                            {shared ? null : (
                                <TopList
                                    title={t("insights.topClients")}
                                    items={shown?.topClients}
                                    names={shown?.clientNames}
                                    empty={t("insights.none")}
                                    hint={t("insights.filterClient")}
                                    onPick={(client) => router.push(logHref({ client, range: "30d" }))}
                                />
                            )}
                            <ShareList
                                title={t("insights.blockedBy")}
                                items={shown?.blockedBy}
                                total={shown?.blocked ?? 0}
                                empty={t("insights.none")}
                                label={(name) => listLabel(t, name)}
                                danger
                            />
                        </div>
                    </>
                )}
            </CardBody>
        </Card>
    );
}
