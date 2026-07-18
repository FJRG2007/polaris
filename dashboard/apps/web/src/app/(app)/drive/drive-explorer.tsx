"use client";

/**
 * The Drive file browser. A connection rail on the left, a breadcrumb and file
 * table (or device metrics) on the right. Navigation is URL-driven
 * (?c=connection&p=path) so the browser is linkable and the back button works.
 *
 * Content loads on the client, not in the server render: the page shell paints
 * immediately and the listing (or the slow UNAS metrics snapshot) streams in
 * behind a skeleton, so a slow NAS no longer stalls the whole navigation. UNAS
 * metrics are cached in localStorage briefly and revalidated in the background
 * (stale-while-revalidate), so revisiting a device is instant. Uploads and
 * downloads still go straight to the streaming Route Handlers.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronRight, File, Folder, FolderPlus, HardDrive, Trash2, Upload } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Badge, Button, Skeleton, cn } from "@polaris/ui";
import type { UnasMetrics as UnasMetricsData } from "@/lib/unifi-unas";
import { deleteEntryAction, mkdirAction } from "./actions";
import { ConnectionDialog } from "./connection-dialog";
import { ShareButton } from "./share-dialog";
import { UnasMetrics } from "./unas-metrics";
import type { ConnectionSummary, DriveEntry } from "./types";

/** How long a cached UNAS metrics snapshot is served before revalidating. */
const METRICS_TTL_MS = 30_000;

function readCache<T>(key: string, ttlMs: number): T | null {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { t: number; v: T };
        if (Date.now() - parsed.t > ttlMs) return null;
        return parsed.v;
    } catch {
        return null;
    }
}

function writeCache<T>(key: string, value: T): void {
    try {
        window.localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
    } catch {
        // Ignore quota / private-mode failures; the cache is only an optimization.
    }
}

export function DriveExplorer({
    connections,
    connectionId,
    path
}: {
    connections: ConnectionSummary[];
    connectionId: string | null;
    path: string;
}) {
    const fileInput = useRef<HTMLInputElement>(null);
    const [pending, startTransition] = useTransition();
    const [uploading, setUploading] = useState(false);

    const [entries, setEntries] = useState<DriveEntry[]>([]);
    const [metrics, setMetrics] = useState<UnasMetricsData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const selected = connections.find((connection) => connection.id === connectionId) ?? null;
    const isUnas = selected?.kind === "unifi-unas";
    const segments = path ? path.split("/") : [];

    const load = useCallback(
        async (signal?: AbortSignal) => {
            if (!connectionId) {
                setEntries([]);
                setMetrics(null);
                setError(null);
                return;
            }
            setError(null);
            if (isUnas) {
                const cacheKey = `polaris:unas:${connectionId}`;
                const cached = readCache<UnasMetricsData>(cacheKey, METRICS_TTL_MS);
                if (cached) {
                    // Optimistic: show the cached snapshot instantly, revalidate quietly.
                    setMetrics(cached);
                    setLoading(false);
                } else {
                    setMetrics(null);
                    setLoading(true);
                }
                try {
                    const res = await fetch(`/api/drive/unas-metrics?c=${encodeURIComponent(connectionId)}`, { signal });
                    const body = await res.json();
                    if (signal?.aborted) return;
                    if (!res.ok) {
                        if (!cached) setError(body.error ?? "Unable to reach the UNAS console");
                    } else {
                        setMetrics(body.metrics as UnasMetricsData);
                        writeCache(cacheKey, body.metrics);
                    }
                } catch {
                    if (!signal?.aborted && !cached) setError("Unable to reach the UNAS console");
                } finally {
                    if (!signal?.aborted) setLoading(false);
                }
                return;
            }
            // File listings are not cached: freshness matters after uploads/deletes.
            setMetrics(null);
            setLoading(true);
            try {
                const query = new URLSearchParams({ c: connectionId });
                if (path) query.set("p", path);
                const res = await fetch(`/api/drive/list?${query.toString()}`, { signal });
                const body = await res.json();
                if (signal?.aborted) return;
                if (!res.ok) {
                    setEntries([]);
                    setError(body.error ?? "Unable to list this location");
                } else {
                    setEntries(body.entries as DriveEntry[]);
                }
            } catch {
                if (!signal?.aborted) setError("Unable to list this location");
            } finally {
                if (!signal?.aborted) setLoading(false);
            }
        },
        [connectionId, isUnas, path]
    );

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

    function href(id: string, target: string) {
        const query = new URLSearchParams({ c: id });
        if (target) query.set("p", target);
        return `/drive?${query.toString()}`;
    }

    async function onUpload(files: FileList | null) {
        if (!files || !connectionId) return;
        setUploading(true);
        for (const file of Array.from(files)) {
            const query = new URLSearchParams({ c: connectionId, name: file.name });
            if (path) query.set("p", path);
            await fetch(`/api/drive/upload?${query.toString()}`, { method: "PUT", body: file });
        }
        setUploading(false);
        if (fileInput.current) fileInput.current.value = "";
        void load();
    }

    function onNewFolder() {
        if (!connectionId) return;
        const name = window.prompt("New folder name");
        if (!name) return;
        startTransition(async () => {
            await mkdirAction(connectionId, path, name);
            void load();
        });
    }

    function onDelete(entryPath: string) {
        if (!connectionId || !window.confirm("Delete this item?")) return;
        // Optimistic: drop the row now; a failed delete reloads the true listing.
        setEntries((prev) => prev.filter((entry) => entry.path !== entryPath));
        startTransition(async () => {
            await deleteEntryAction(connectionId, entryPath);
            void load();
        });
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
            <aside className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium text-muted-foreground">Connections</h2>
                    <ConnectionDialog />
                </div>
                <nav className="flex flex-col gap-1">
                    {connections.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No connections yet.</p>
                    ) : (
                        connections.map((connection) => (
                            <Link
                                key={connection.id}
                                href={href(connection.id, "")}
                                className={cn(
                                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                                    connection.id === connectionId && "bg-muted font-medium"
                                )}
                            >
                                <HardDrive className="size-4 text-muted-foreground" />
                                <span className="flex-1 truncate">{connection.name}</span>
                                {connection.requiresHostd ? <Badge variant="neutral">host</Badge> : null}
                            </Link>
                        ))
                    )}
                </nav>
            </aside>

            <section className="min-w-0">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
                        {connectionId && !isUnas ? (
                            <>
                                <Link href={href(connectionId, "")} className="hover:text-foreground">
                                    Home
                                </Link>
                                {segments.map((segment, index) => {
                                    const target = segments.slice(0, index + 1).join("/");
                                    return (
                                        <span key={target} className="flex items-center gap-1">
                                            <ChevronRight className="size-3" />
                                            <Link
                                                href={href(connectionId, target)}
                                                className="truncate hover:text-foreground"
                                            >
                                                {segment}
                                            </Link>
                                        </span>
                                    );
                                })}
                            </>
                        ) : null}
                    </div>
                    {connectionId && !isUnas ? (
                        <div className="flex items-center gap-2">
                            <Button size="sm" variant="ghost" onClick={onNewFolder} disabled={pending}>
                                <FolderPlus className="size-4" />
                                New folder
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => fileInput.current?.click()}
                                disabled={uploading}
                            >
                                <Upload className="size-4" />
                                {uploading ? "Uploading..." : "Upload"}
                            </Button>
                            <input
                                ref={fileInput}
                                type="file"
                                multiple
                                hidden
                                onChange={(event) => onUpload(event.target.files)}
                            />
                        </div>
                    ) : null}
                </div>

                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Add a storage connection to start browsing.
                    </div>
                ) : loading && !metrics ? (
                    isUnas ? (
                        <MetricsSkeleton />
                    ) : (
                        <ListingSkeleton />
                    )
                ) : error ? (
                    <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                        {error}
                    </div>
                ) : isUnas && metrics ? (
                    <UnasMetrics metrics={metrics} />
                ) : (
                    <div className="overflow-hidden rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-3 py-2 font-medium">Name</th>
                                    <th className="px-3 py-2 font-medium">Size</th>
                                    <th className="hidden px-3 py-2 font-medium sm:table-cell">Modified</th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {entries.length === 0 ? (
                                    <tr>
                                        <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                                            This folder is empty.
                                        </td>
                                    </tr>
                                ) : (
                                    entries.map((entry) => (
                                        <tr key={entry.path} className="border-t border-border hover:bg-card-hover">
                                            <td className="px-3 py-2">
                                                {entry.kind === "dir" ? (
                                                    <Link
                                                        href={href(connectionId, entry.path)}
                                                        className="flex items-center gap-2 hover:text-primary"
                                                    >
                                                        <Folder className="size-4 text-primary" />
                                                        {entry.name}
                                                    </Link>
                                                ) : (
                                                    <a
                                                        href={`/api/drive/download?c=${connectionId}&p=${encodeURIComponent(entry.path)}`}
                                                        className="flex items-center gap-2 hover:text-primary"
                                                    >
                                                        <File className="size-4 text-muted-foreground" />
                                                        {entry.name}
                                                    </a>
                                                )}
                                            </td>
                                            <td className="px-3 py-2 text-muted-foreground">
                                                {entry.kind === "dir" ? "-" : formatBytes(BigInt(entry.size))}
                                            </td>
                                            <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                                                {new Date(entry.modifiedAt).toLocaleString()}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    <ShareButton
                                                        connectionId={connectionId}
                                                        path={entry.path}
                                                        name={entry.name}
                                                        isDir={entry.kind === "dir"}
                                                    />
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        onClick={() => onDelete(entry.path)}
                                                        disabled={pending}
                                                        aria-label={`Delete ${entry.name}`}
                                                    >
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}

/** Placeholder while a directory listing loads. */
function ListingSkeleton() {
    return (
        <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex flex-col divide-y divide-border">
                {Array.from({ length: 6 }).map((_, index) => (
                    <div key={index} className="flex items-center gap-3 px-3 py-2.5">
                        <Skeleton className="size-4 rounded" />
                        <Skeleton className="h-4 flex-1 max-w-[40%]" />
                        <Skeleton className="ml-auto h-4 w-16" />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Placeholder while the UNAS metrics snapshot loads. */
function MetricsSkeleton() {
    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-20" />
                ))}
            </div>
            <Skeleton className="h-40" />
            <Skeleton className="h-52" />
        </div>
    );
}
