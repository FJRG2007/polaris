"use client";

/**
 * The three rankings, and a way into every row.
 *
 * Nothing is measured until somebody asks for a location: a walk costs a real
 * connection to a real NAS, and doing it on arrival would spend it on whichever
 * location happened to be first in the list.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { StorageProviderKind } from "@polaris/core";
import type { DriveBreakdown } from "@/lib/drive-breakdown";
import { FolderOpen, HardDrive, Loader2, Search } from "lucide-react";
import { Badge, Button, Card, CardBody, EmptyState, Select } from "@polaris/ui";

export interface InsightLocation {
    id: string;
    name: string;
    kind: StorageProviderKind;
}

function size(bytes: number): string {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function count(value: number, one: string, many: string): string {
    return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

/** Where a row opens: the folder itself, or the folder a file is in. */
function driveHref(connectionId: string, path: string): string {
    return `/drive?c=${encodeURIComponent(connectionId)}&p=${encodeURIComponent(path)}`;
}

/** One ranked list, drawn as a bar against the largest row in it so the shape of
 *  the answer is visible before any number is read. */
function Ranking({
    title,
    hint,
    rows
}: {
    title: string;
    hint: string;
    rows: Array<{ key: string; label: string; note: string; bytes: number; href?: string }>;
}) {
    const largest = rows[0]?.bytes ?? 0;
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-muted-foreground text-xs">{hint}</p>
                </div>
                {rows.length === 0 ? (
                    <p className="text-muted-foreground text-xs">Nothing here.</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {rows.map((row) => (
                            <li key={row.key} className="flex flex-col gap-1">
                                <span className="flex items-baseline justify-between gap-3 text-sm">
                                    <span className="min-w-0 truncate" title={row.label}>
                                        {row.href ? (
                                            <Link href={row.href} className="hover:text-primary hover:underline">
                                                {row.label}
                                            </Link>
                                        ) : (
                                            row.label
                                        )}
                                    </span>
                                    <span className="shrink-0 tabular-nums">{size(row.bytes)}</span>
                                </span>
                                <span
                                    aria-hidden
                                    className="bg-muted h-1 w-full overflow-hidden rounded-full"
                                >
                                    <span
                                        className="bg-primary/70 block h-full rounded-full"
                                        style={{
                                            width: `${largest > 0 ? Math.max(2, (row.bytes / largest) * 100) : 0}%`
                                        }}
                                    />
                                </span>
                                <span className="text-muted-foreground truncate text-xs" title={row.note}>{row.note}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}

export function DriveInsights({
    locations,
    initial
}: {
    locations: InsightLocation[];
    initial: string | null;
}) {
    const [connectionId, setConnectionId] = useState(initial);
    const [report, setReport] = useState<DriveBreakdown | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const measure = useCallback(async (id: string) => {
        setBusy(true);
        setError(null);
        setReport(null);
        try {
            const response = await fetch(`/api/drive/breakdown?c=${encodeURIComponent(id)}`);
            const body = (await response.json()) as DriveBreakdown & {
                error?: string;
                locked?: boolean;
                needsSmbShare?: boolean;
            };
            if (body.error) setError(body.error);
            else if (body.locked) setError("This location is locked.");
            else if (body.needsSmbShare) setError("This location needs its share chosen in Drive first.");
            else setReport(body);
        } catch {
            setError("Could not reach the server.");
        }
        setBusy(false);
    }, []);

    useEffect(() => {
        if (connectionId) void measure(connectionId);
    }, [connectionId, measure]);

    if (locations.length === 0) {
        return (
            <EmptyState
                icon={<HardDrive />}
                title="No locations"
                description="Connect a NAS or a folder in Drive and this will say what is filling it."
            />
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    value={connectionId ?? ""}
                    onValueChange={setConnectionId}
                    aria-label="Location"
                    className="w-64"
                    options={locations.map((location) => ({ value: location.id, label: location.name }))}
                />
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !connectionId}
                    onClick={() => connectionId && void measure(connectionId)}
                >
                    {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Search className="size-4 shrink-0" />}
                    {busy ? "Walking" : "Measure again"}
                </Button>
                {connectionId ? (
                    <Button variant="ghost" size="sm" asChild>
                        <Link href={driveHref(connectionId, "")}>
                            <FolderOpen className="size-4 shrink-0" />
                            Open in Drive
                        </Link>
                    </Button>
                ) : null}
            </div>

            {error ? <p className="text-danger text-sm">{error}</p> : null}

            {busy && !report ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Loader2 className="size-4 shrink-0 animate-spin" />
                    Walking this location. It stops after a few seconds and reports what it reached.
                </p>
            ) : null}

            {report ? (
                <>
                    <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                        <span>
                            {size(report.bytes)} across {count(report.fileCount, "file", "files")} in{" "}
                            {count(report.folderCount, "folder", "folders")}.
                        </span>
                        {report.partial ? (
                            <Badge variant="warning">
                                Stopped early - everything here is at least this much
                            </Badge>
                        ) : null}
                    </p>

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                        <Ranking
                            title="Heaviest folders"
                            hint="Top level, by what everything under it adds up to."
                            rows={report.folders.map((folder) => ({
                                key: folder.path,
                                label: folder.name,
                                note: count(folder.files, "file", "files"),
                                bytes: folder.bytes,
                                href: connectionId ? driveHref(connectionId, folder.path) : undefined
                            }))}
                        />
                        <Ranking
                            title="Biggest files"
                            hint="One file each. Opens the folder it is in."
                            rows={report.files.map((file) => ({
                                key: file.path,
                                label: file.name,
                                note: file.folder || "the top level",
                                bytes: file.bytes,
                                href: connectionId ? driveHref(connectionId, file.folder) : undefined
                            }))}
                        />
                        <Ranking
                            title="What the formats weigh"
                            hint="Every file of a kind, added up."
                            rows={report.formats.map((format) => ({
                                key: format.ext || "none",
                                label: format.label,
                                note: count(format.files, "file", "files"),
                                bytes: format.bytes
                            }))}
                        />
                    </div>
                </>
            ) : null}
        </div>
    );
}
