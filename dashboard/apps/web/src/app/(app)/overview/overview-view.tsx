"use client";

/**
 * Overview: one section per connected NAS with its device metrics - storage,
 * health, disks (UniFi UNAS) or properties and usage (other backends). This is
 * the "manage the devices" view; the Files page is purely for browsing files.
 * Metrics load on the client behind a skeleton so a slow device never blocks the
 * page, and each section links straight to that device's files.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderOpen, HardDrive } from "lucide-react";
import { Button, Card, CardBody, Skeleton } from "@polaris/ui";
import type { UnasMetrics as UnasMetricsData } from "@/lib/unifi-unas";
import { HardwarePanel } from "../drive/hardware-panel";
import { UnasMetrics } from "../drive/unas-metrics";
import type { ConnectionSummary } from "../drive/types";

function UnasSection({ connection }: { connection: ConnectionSummary }) {
    const [metrics, setMetrics] = useState<UnasMetricsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        fetch(`/api/drive/unas-metrics?c=${encodeURIComponent(connection.id)}`, { signal: controller.signal })
            .then(async (res) => {
                const body = await res.json();
                if (!res.ok) throw new Error(body.error ?? "Unable to reach the device");
                setMetrics(body.metrics as UnasMetricsData);
            })
            .catch((caught) => {
                if (!controller.signal.aborted) {
                    setError(caught instanceof Error ? caught.message : "Unable to reach the device");
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [connection.id]);

    if (loading) {
        return (
            <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <Skeleton key={index} className="h-20" />
                    ))}
                </div>
                <Skeleton className="h-40" />
            </div>
        );
    }
    if (error) {
        return (
            <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
        );
    }
    return metrics ? <UnasMetrics metrics={metrics} /> : null;
}

export function OverviewView({ connections }: { connections: ConnectionSummary[] }) {
    if (connections.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    No devices yet. Add one from the Files page to see its metrics here.
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-8">
            {connections.map((connection) => (
                <section key={connection.id} className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                        <div className="flex items-center gap-2">
                            <HardDrive className="size-5 text-primary" />
                            <h2 className="text-base font-semibold">{connection.name}</h2>
                        </div>
                        <Button asChild size="sm" variant="secondary">
                            <Link href={`/drive?c=${connection.id}`}>
                                <FolderOpen className="size-4" />
                                Browse files
                            </Link>
                        </Button>
                    </div>
                    {connection.kind === "unifi-unas" ? (
                        <UnasSection connection={connection} />
                    ) : (
                        <HardwarePanel connection={connection} />
                    )}
                </section>
            ))}
        </div>
    );
}
