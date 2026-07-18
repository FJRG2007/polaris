"use client";

/**
 * "Hardware & properties" for a non-UNAS connection: what kind of backend it is,
 * where it routes, and its storage usage when the driver can report it. UNAS
 * connections render their richer device dashboard instead (see UnasMetrics).
 */

import { useEffect, useState } from "react";
import { Database, HardDrive } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Badge, Card, CardBody, CardHeader, CardTitle, RadialGauge, Skeleton } from "@polaris/ui";
import type { ConnectionSummary } from "./types";

const KIND_LABELS: Record<string, string> = {
    local: "Local folder",
    sftp: "SFTP / SSH",
    webdav: "WebDAV",
    s3: "S3-compatible",
    smb: "SMB / CIFS",
    nfs: "NFS",
    synology: "Synology DSM",
    qnap: "QNAP QTS",
    truenas: "TrueNAS",
    "unifi-unas": "UniFi UNAS"
};

interface Usage {
    total: string | null;
    used: string | null;
    free: string | null;
}

export function HardwarePanel({ connection }: { connection: ConnectionSummary }) {
    const [usage, setUsage] = useState<Usage | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        fetch(`/api/drive/usage?c=${encodeURIComponent(connection.id)}`, { signal: controller.signal })
            .then(async (res) => {
                const body = await res.json();
                if (!res.ok) throw new Error(body.error ?? "Unable to read usage");
                setUsage(body as Usage);
            })
            .catch((caught) => {
                if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to read usage");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [connection.id]);

    const total = usage?.total ? Number(usage.total) : 0;
    const used = usage?.used ? Number(usage.used) : 0;
    const ratio = total > 0 ? used / total : 0;
    const tone = ratio >= 0.9 ? "danger" : ratio >= 0.75 ? "warning" : "primary";

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader>
                    <CardTitle>Properties</CardTitle>
                </CardHeader>
                <CardBody>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <dt className="text-muted-foreground">Name</dt>
                        <dd className="truncate font-medium">{connection.name}</dd>
                        <dt className="text-muted-foreground">Type</dt>
                        <dd className="font-medium">{KIND_LABELS[connection.kind] ?? connection.kind}</dd>
                        <dt className="text-muted-foreground">Host access</dt>
                        <dd>
                            {connection.requiresHostd ? (
                                <Badge variant="neutral">requires host daemon</Badge>
                            ) : (
                                <span className="text-muted-foreground">in-process</span>
                            )}
                        </dd>
                    </dl>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Storage usage</CardTitle>
                </CardHeader>
                <CardBody>
                    {loading ? (
                        <div className="flex items-center gap-4">
                            <Skeleton className="size-24 rounded-full" />
                            <Skeleton className="h-4 flex-1 max-w-xs" />
                        </div>
                    ) : error ? (
                        <p className="text-sm text-muted-foreground">{error}</p>
                    ) : total > 0 ? (
                        <div className="flex flex-wrap items-center gap-6">
                            <RadialGauge value={ratio} label={`${Math.round(ratio * 100)}%`} sublabel="used" tone={tone} />
                            <div className="flex flex-col gap-1 text-sm">
                                <span className="flex items-center gap-2">
                                    <Database className="size-4 text-muted-foreground" />
                                    {formatBytes(BigInt(usage?.used ?? "0"))} used of{" "}
                                    {formatBytes(BigInt(usage?.total ?? "0"))}
                                </span>
                                {usage?.free ? (
                                    <span className="flex items-center gap-2 text-muted-foreground">
                                        <HardDrive className="size-4" />
                                        {formatBytes(BigInt(usage.free))} free
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">This backend does not report storage usage.</p>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
