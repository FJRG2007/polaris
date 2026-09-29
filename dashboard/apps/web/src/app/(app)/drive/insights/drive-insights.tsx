"use client";

/**
 * The three rankings, and a way into every row.
 *
 * Nothing is measured until somebody asks for a location: a walk costs a real
 * connection to a real NAS, and doing it on arrival would spend it on whichever
 * location happened to be first in the list.
 */

import Link from "next/link";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    const t = useTranslations("drive");
    const largest = rows[0]?.bytes ?? 0;
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-muted-foreground text-xs">{hint}</p>
                </div>
                {rows.length === 0 ? (
                    <p className="text-muted-foreground text-xs">{t("insights.nothingHere")}</p>
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
    const t = useTranslations("drive");
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
                title={t("insights.noLocations")}
                description={t("insights.connectANasOrA")}
            />
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    value={connectionId ?? ""}
                    onValueChange={setConnectionId}
                    aria-label={t("insights.location")}
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
                    {busy ? t("insights.walking") : t("insights.measureAgain")}
                </Button>
                {connectionId ? (
                    <Button variant="ghost" size="sm" asChild>
                        <Link href={driveHref(connectionId, "")}>
                            <FolderOpen className="size-4 shrink-0" />
                            {t("insights.openInDrive")}
                        </Link>
                    </Button>
                ) : null}
            </div>

            {error ? <p className="text-danger text-sm">{error}</p> : null}

            {busy && !report ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Loader2 className="size-4 shrink-0 animate-spin" />
                    {t("insights.walkingThisLocationItStops")}
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
                                {t("insights.stoppedEarlyEverythingHereIs")}
                            </Badge>
                        ) : null}
                    </p>

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                        <Ranking
                            title={t("insights.heaviestFolders")}
                            hint={t("insights.topLevelByWhatEverything")}
                            rows={report.folders.map((folder) => ({
                                key: folder.path,
                                label: folder.name,
                                note: count(folder.files, "file", "files"),
                                bytes: folder.bytes,
                                href: connectionId ? driveHref(connectionId, folder.path) : undefined
                            }))}
                        />
                        <Ranking
                            title={t("insights.biggestFiles")}
                            hint={t("insights.oneFileEachOpensThe")}
                            rows={report.files.map((file) => ({
                                key: file.path,
                                label: file.name,
                                note: file.folder || "the top level",
                                bytes: file.bytes,
                                href: connectionId ? driveHref(connectionId, file.folder) : undefined
                            }))}
                        />
                        <Ranking
                            title={t("insights.whatTheFormatsWeigh")}
                            hint={t("insights.everyFileOfAKind")}
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
