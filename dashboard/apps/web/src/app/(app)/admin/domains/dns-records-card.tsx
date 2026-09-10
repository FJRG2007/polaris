"use client";

/**
 * The records of every zone this Polaris's Cloudflare token reaches, edited here
 * rather than in another tab at Cloudflare.
 *
 * Its chrome paints at once and the zones are read after; with no token there is
 * nothing to edit, and the card says where one is connected instead of drawing an
 * empty picker.
 */

import Link from "next/link";
import { Server } from "lucide-react";
import { useEffect, useState } from "react";
import { DnsZoneEditor } from "@/components/dns/dns-zone-editor";
import { listDnsZonesAction } from "@/app/(app)/account/domains/dns-actions";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    EmptyState,
    Select,
    Skeleton
} from "@polaris/ui";

export function DnsRecordsCard() {
    const [zones, setZones] = useState<{ id: string; name: string }[] | null>(null);
    const [zoneId, setZoneId] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        let live = true;
        void listDnsZonesAction()
            .catch(() => ({ error: "Could not read the zones", zones: undefined }))
            .then((result) => {
                if (!live) return;
                if (result.zones) {
                    setZones(result.zones);
                    setZoneId((current) => current || result.zones![0]?.id || "");
                } else setError(result.error ?? "Could not read the zones");
            });
        return () => {
            live = false;
        };
    }, []);

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                    <Server className="size-4 text-primary" /> DNS records
                </CardTitle>
                {zones && zones.length > 1 && (
                    <Select
                        value={zoneId}
                        onValueChange={setZoneId}
                        options={zones.map((zone) => ({ value: zone.id, label: zone.name }))}
                        className="w-full sm:w-64"
                        aria-label="Zone"
                    />
                )}
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-muted-foreground text-sm">
                    The zones this Polaris&rsquo;s Cloudflare token can edit. Check where a change
                    has reached before relying on it.
                </p>
                {error ? (
                    <p role="alert" className="text-danger text-sm">
                        {error}
                    </p>
                ) : zones === null ? (
                    <div className="flex flex-col gap-2" aria-busy="true">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-24 w-full rounded-lg" />
                    </div>
                ) : zones.length === 0 ? (
                    <EmptyState
                        title="No zone to edit"
                        description="Connect a Cloudflare token that can edit DNS, and its zones appear here."
                        action={
                            <Button asChild size="sm" variant="secondary">
                                <Link href="/admin/integrations">Open Integrations</Link>
                            </Button>
                        }
                    />
                ) : zoneId ? (
                    <DnsZoneEditor key={zoneId} scope={{ kind: "instance", zoneId }} />
                ) : null}
            </CardBody>
        </Card>
    );
}
