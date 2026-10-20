"use client";

/**
 * Every device the log has seen over a range: the name it goes by, first and
 * last lookup, how many and how many blocked, and the groups whose lists it
 * gets. A device opens the query log narrowed to it.
 */

import Link from "next/link";
import { logHref } from "./dns-insights";
import { useEffect, useState } from "react";
import { dnsDevicesAction } from "./actions";
import { Loader2, RefreshCw, Tag } from "lucide-react";
import type { NetworkDevice } from "@/lib/dns-blocker/devices";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DNS_RANGE_IDS, type DnsRange } from "@/lib/dns-blocker/query-log";
import { Button, Card, CardBody, CardHeader, CardTitle, Select, Skeleton } from "@polaris/ui";

export function DnsNetworkCard({ onName }: { onName: (address: string) => void }) {
    const t = useTranslations("dnsBlocker");
    const [range, setRange] = useState<DnsRange>("24h");
    const [devices, setDevices] = useState<NetworkDevice[] | null>(null);
    const [logOff, setLogOff] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [fresh, setFresh] = useState(0);

    useEffect(() => {
        let live = true;
        setLoading(true);
        void dnsDevicesAction({ range, fresh: fresh > 0 }).then((result) => {
            if (!live) return;
            setLoading(false);
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            setError(null);
            setDevices(result.devices);
            setLogOff(result.logOff);
        });
        return () => {
            live = false;
        };
    }, [range, fresh]);

    const when = (at: number) => (at > 0 ? new Date(at).toLocaleString() : "");

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                    <CardTitle>{t("network.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("network.intro")}</p>
                </div>
                <Select
                    className="w-36"
                    value={range}
                    aria-label={t("insights.range")}
                    onValueChange={(value) => setRange(value as DnsRange)}
                    options={DNS_RANGE_IDS.map((id) => ({ value: id, label: t(`insights.ranges.${id}`) }))}
                />
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("network.refresh")}
                    title={t("network.refresh")}
                    disabled={loading}
                    onClick={() => setFresh((count) => count + 1)}
                >
                    {loading ? (
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : (
                        <RefreshCw className="size-4 shrink-0" />
                    )}
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {error ? <p className="text-sm text-danger-ink">{error}</p> : null}
                {devices === null && !error ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                    </div>
                ) : null}
                {devices && devices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {logOff ? t("insights.logOff") : t("network.empty")}
                    </p>
                ) : null}
                {devices && devices.length > 0 ? (
                    <div className="max-h-[28rem] overflow-auto">
                        <table className="w-full min-w-[40rem] text-sm">
                            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="p-1 font-medium">{t("network.device")}</th>
                                    <th className="p-1 font-medium">{t("network.firstSeen")}</th>
                                    <th className="p-1 font-medium">{t("network.lastSeen")}</th>
                                    <th className="p-1 text-right font-medium">
                                        {t("network.queries")}
                                    </th>
                                    <th className="p-1 text-right font-medium">
                                        {t("network.blocked")}
                                    </th>
                                    <th className="p-1 font-medium">{t("network.groups")}</th>
                                    <th className="p-1" />
                                </tr>
                            </thead>
                            <tbody>
                                {devices.map((device) => {
                                    const name = device.ownName || device.name;
                                    const share =
                                        device.queries > 0
                                            ? Math.round((device.blocked / device.queries) * 1000) /
                                              10
                                            : 0;
                                    const groups = device.groups.join(", ") || t("network.everyone");
                                    return (
                                        <tr key={device.address} className="border-t">
                                            <td className="max-w-[14rem] p-1 align-top">
                                                <Link
                                                    href={logHref({ client: device.address, range })}
                                                    className="flex min-w-0 flex-col hover:underline"
                                                    title={t("network.openLog")}
                                                >
                                                    <span className="truncate font-medium">
                                                        {name || device.address}
                                                    </span>
                                                    {name ? (
                                                        <span className="truncate font-mono text-xs text-muted-foreground">
                                                            {device.address}
                                                        </span>
                                                    ) : null}
                                                </Link>
                                            </td>
                                            <td className="whitespace-nowrap p-1 align-top text-xs">
                                                {when(device.first)}
                                            </td>
                                            <td className="whitespace-nowrap p-1 align-top text-xs">
                                                {when(device.last)}
                                            </td>
                                            <td className="p-1 text-right align-top tabular-nums">
                                                {device.queries.toLocaleString()}
                                            </td>
                                            <td className="whitespace-nowrap p-1 text-right align-top tabular-nums">
                                                {device.blocked.toLocaleString()} ({share}%)
                                            </td>
                                            <td
                                                className="max-w-[10rem] truncate p-1 align-top text-xs"
                                                title={groups}
                                            >
                                                {groups}
                                            </td>
                                            <td className="p-1 text-right align-top">
                                                {device.ownName ? null : (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={`${t("network.name")}: ${device.address}`}
                                                        title={t("network.name")}
                                                        onClick={() => onName(device.address)}
                                                    >
                                                        <Tag className="size-4 shrink-0" />
                                                    </Button>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}
