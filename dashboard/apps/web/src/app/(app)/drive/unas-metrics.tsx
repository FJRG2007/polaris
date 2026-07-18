"use client";

/**
 * UniFi UNAS device metrics, in the spirit of the UNAS Pro dashboard: overall
 * storage, the RAID pool with its health, the per-slot disks with temperature
 * and health, and system vitals. Values come from the UniFi OS system websocket
 * server-side; this only renders them.
 */

import type { ReactNode } from "react";
import { Cpu, Database, HardDrive, Thermometer, TriangleAlert } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import type { UnasMetrics as UnasMetricsData } from "@/lib/unifi-unas";

/** Seconds -> "3d 12h" / "12h 4m" / "4m". */
function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

export function UnasMetrics({ metrics }: { metrics: UnasMetricsData }) {
    const usedPct = metrics.totalBytes > 0 ? Math.round((metrics.usedBytes / metrics.totalBytes) * 100) : 0;
    const atRisk = metrics.health !== "healthy";

    return (
        <div className="flex flex-col gap-4">
            {atRisk ? (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>
                        Storage is at risk. Check the pool below - a degraded RAID keeps serving data but has no
                        redundancy until the missing disk is replaced.
                    </span>
                </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat
                    icon={<Database className="size-4" />}
                    label="Storage"
                    value={`${formatBytes(metrics.usedBytes)} / ${formatBytes(metrics.totalBytes)}`}
                    hint={`${usedPct}% used`}
                />
                <Stat
                    icon={<HardDrive className="size-4" />}
                    label="Slots"
                    value={`${metrics.slotsPopulated} / ${metrics.slotsTotal}`}
                    hint="populated"
                />
                <Stat
                    icon={<Cpu className="size-4" />}
                    label="CPU"
                    value={metrics.system.cpuLoad !== null ? `${Math.round(metrics.system.cpuLoad * 100)}%` : "-"}
                    hint={metrics.system.cpuTemp !== null ? `${metrics.system.cpuTemp} C` : "load"}
                />
                <Stat
                    icon={<Thermometer className="size-4" />}
                    label="Memory"
                    value={`${formatBytes(metrics.system.memoryUsedBytes)} / ${formatBytes(metrics.system.memoryTotalBytes)}`}
                    hint={`up ${formatUptime(metrics.system.uptimeSeconds)}`}
                />
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Storage pools</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    {metrics.pools.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No pools reported.</p>
                    ) : (
                        metrics.pools.map((pool) => (
                            <div key={pool.device}>
                                <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                                    <span className="flex items-center gap-2">
                                        <span className="font-medium">{pool.device}</span>
                                        {pool.raidLevel ? (
                                            <Badge variant="neutral">{pool.raidLevel}</Badge>
                                        ) : null}
                                        <Badge variant={pool.health === "health" ? "success" : "danger"}>
                                            {pool.raidState ?? pool.health}
                                        </Badge>
                                    </span>
                                    <span className="text-muted-foreground">
                                        {formatBytes(pool.usedBytes)} / {formatBytes(pool.totalBytes)}
                                    </span>
                                </div>
                                <Meter used={pool.usedBytes} total={pool.totalBytes} />
                                <div className="mt-1 text-xs text-muted-foreground">
                                    {pool.membersPresent}/{pool.membersExpected} disks
                                    {pool.reasons.length > 0 ? ` - ${pool.reasons.join(", ").replace(/_/g, " ")}` : ""}
                                </div>
                            </div>
                        ))
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Drive bays</CardTitle>
                </CardHeader>
                <CardBody>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {metrics.disks.map((disk) => (
                            <div
                                key={disk.slot}
                                className={`rounded-md border p-3 ${
                                    disk.present ? "border-border bg-card" : "border-dashed border-border/60"
                                }`}
                            >
                                <div className="flex items-center justify-between text-sm">
                                    <span className="flex items-center gap-2 font-medium">
                                        <HardDrive
                                            className={`size-4 ${disk.present ? "text-primary" : "text-muted-foreground"}`}
                                        />
                                        Bay {disk.slot}
                                    </span>
                                    {disk.present ? (
                                        <Badge variant={disk.healthy ? "success" : "danger"}>
                                            {disk.healthy ? "healthy" : disk.state}
                                        </Badge>
                                    ) : (
                                        <span className="text-xs text-muted-foreground">empty</span>
                                    )}
                                </div>
                                {disk.present ? (
                                    <div className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
                                        <span className="truncate text-foreground">{disk.model ?? "Disk"}</span>
                                        <span>
                                            {formatBytes(disk.sizeBytes)}
                                            {disk.type ? ` ${disk.type}` : ""}
                                            {disk.rpm ? ` - ${disk.rpm} rpm` : ""}
                                        </span>
                                        {disk.temperature !== null ? <span>{disk.temperature} C</span> : null}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </CardBody>
            </Card>

            <p className="text-xs text-muted-foreground">
                {metrics.system.name} - {metrics.system.model}
                {metrics.system.firmware ? ` - firmware ${metrics.system.firmware}` : ""}
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

function Meter({ used, total }: { used: number; total: number }) {
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    return (
        <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
    );
}
