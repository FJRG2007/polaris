"use client";

/**
 * The Drive file browser. A connection rail on the left, a breadcrumb and file
 * table on the right. Navigation is URL-driven (?c=connection&p=path) so the
 * browser is linkable and the back button works; mutations call the server
 * actions and refresh. Uploads and downloads go straight to the streaming Route
 * Handlers so large files never pass through a Server Action.
 */

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, File, Folder, FolderPlus, HardDrive, Trash2, Upload } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Badge, Button, cn } from "@polaris/ui";
import type { UnasMetrics as UnasMetricsData } from "@/lib/unifi-unas";
import { deleteEntryAction, mkdirAction } from "./actions";
import { ConnectionDialog } from "./connection-dialog";
import { ShareButton } from "./share-dialog";
import { UnasMetrics } from "./unas-metrics";
import type { ConnectionSummary, DriveEntry } from "./types";

export function DriveExplorer({
    connections,
    connectionId,
    path,
    entries,
    error,
    unasMetrics
}: {
    connections: ConnectionSummary[];
    connectionId: string | null;
    path: string;
    entries: DriveEntry[];
    error: string | null;
    unasMetrics: UnasMetricsData | null;
}) {
    const router = useRouter();
    const fileInput = useRef<HTMLInputElement>(null);
    const [pending, startTransition] = useTransition();
    const [uploading, setUploading] = useState(false);

    const segments = path ? path.split("/") : [];

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
        router.refresh();
    }

    function onNewFolder() {
        if (!connectionId) return;
        const name = window.prompt("New folder name");
        if (!name) return;
        startTransition(async () => {
            await mkdirAction(connectionId, path, name);
            router.refresh();
        });
    }

    function onDelete(entryPath: string) {
        if (!connectionId || !window.confirm("Delete this item?")) return;
        startTransition(async () => {
            await deleteEntryAction(connectionId, entryPath);
            router.refresh();
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
                        {connectionId && !unasMetrics ? (
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
                    {connectionId && !unasMetrics ? (
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

                {error ? (
                    <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                        {error}
                    </div>
                ) : !connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Add a storage connection to start browsing.
                    </div>
                ) : unasMetrics ? (
                    <UnasMetrics metrics={unasMetrics} />
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
