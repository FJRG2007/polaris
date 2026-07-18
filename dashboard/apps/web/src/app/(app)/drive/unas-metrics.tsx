"use client";

/**
 * UniFi UNAS device metrics, in the spirit of the UNAS Pro dashboard: overall
 * storage, per-pool capacity, shared drives with usage and snapshots, and live
 * throughput. Values come from the UniFi OS console API server-side; this only
 * renders them.
 */

import type { ReactNode } from "react";
import { Boxes, Database, FolderTree, Gauge } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import type { UnasMetrics } from "@/lib/unifi-unas";

export function UnasMetrics({ metrics }: { metrics: UnasMetrics }) {
    const usedPct =
        metrics.totalBytes > 0 ? Math.round((metrics.usedBytes / metrics.totalBytes) * 100) : 0;

    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat icon={<Database className="size-4" />} label="Storage" value={`${formatBytes(metrics.usedBytes)} / ${formatBytes(metrics.totalBytes)}`} hint={`${usedPct}% used`} />
                <Stat icon={<Boxes className="size-4" />} label="Pools" value={String(metrics.pools.length)} hint="storage pools" />
                <Stat icon={<FolderTree className="size-4" />} label="Shares" value={String(metrics.shares.length)} hint="shared drives" />
                <Stat icon={<Gauge className="size-4" />} label="Throughput" value={`R ${formatBytes(metrics.throughput.read)}/s`} hint={`W ${formatBytes(metrics.throughput.write)}/s`} />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>Storage pools</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3">
                        {metrics.pools.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No pools reported.</p>
                        ) : (
                            metrics.pools.map((pool) => (
                                <Meter key={pool.name} label={pool.name} used={pool.used} total={pool.total} />
                            ))
                        )}
                    </CardBody>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Shared drives</CardTitle>
                    </CardHeader>
                    <CardBody>
                        {metrics.shares.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No shares reported.</p>
                        ) : (
                            <ul className="flex flex-col gap-2">
                                {metrics.shares.map((share) => (
                                    <li key={share.name} className="flex items-center justify-between gap-2 text-sm">
                                        <span className="min-w-0 truncate">
                                            {share.name}
                                            {share.snapshots ? (
                                                <Badge variant="primary" className="ml-2">
                                                    snapshots
                                                </Badge>
                                            ) : null}
                                        </span>
                                        <span className="whitespace-nowrap text-muted-foreground">
                                            {formatBytes(share.used)}
                                            {share.quota ? ` / ${formatBytes(share.quota)}` : ""}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </Card>
            </div>

            <p className="text-xs text-muted-foreground">
                {metrics.system.name}
                {metrics.system.version ? ` - ${metrics.system.version}` : ""}
            </p>
        </div>
    );
}

function Stat({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
    return (
        <Card>
            <CardBody className="p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    {icon}
                    {label}
                </div>
                <div className="truncate text-lg font-semibold">{value}</div>
                <div className="truncate text-xs text-muted-foreground">{hint}</div>
            </CardBody>
        </Card>
    );
}

function Meter({ label, used, total }: { label: string; used: number; total: number }) {
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    return (
        <div>
            <div className="mb-1 flex items-center justify-between text-sm">
                <span className="truncate">{label}</span>
                <span className="text-muted-foreground">
                    {formatBytes(used)} / {formatBytes(total)}
                </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}
