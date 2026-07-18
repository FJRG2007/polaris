"use client";

/**
 * The Drive browser for one connection, split into two sub-tabs: "Files" (the
 * explorer - browse, upload, download, share) and "Hardware" (device metrics and
 * properties). Navigation is URL-driven (?c=connection&p=path) so it is linkable
 * and the back button works; the tab is local state that defaults to whichever
 * makes sense for the backend (a UNAS opens on Hardware, a file store on Files).
 *
 * Content loads on the client, not in the server render, so the shell paints
 * immediately and a slow NAS streams in behind a skeleton. UNAS metrics are
 * cached in localStorage briefly and revalidated in the background.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronRight, File, Folder, FolderPlus, HardDrive, Info, Trash2, Upload } from "lucide-react";
import { formatBytes } from "@polaris/core";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton,
    cn
} from "@polaris/ui";
import type { UnasMetrics as UnasMetricsData } from "@/lib/unifi-unas";
import { deleteEntryAction, mkdirAction, setUnasShareAction } from "./actions";
import { ConnectionDialog } from "./connection-dialog";
import { HardwarePanel } from "./hardware-panel";
import { ShareButton } from "./share-dialog";
import { UnasMetrics } from "./unas-metrics";
import type { ConnectionSummary, DriveEntry } from "./types";

type DriveView = "files" | "hardware";

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

    const [view, setView] = useState<DriveView>("files");
    const [entries, setEntries] = useState<DriveEntry[]>([]);
    const [metrics, setMetrics] = useState<UnasMetricsData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [needsSmbShare, setNeedsSmbShare] = useState(false);
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [deleteTarget, setDeleteTarget] = useState<DriveEntry | null>(null);

    const selected = connections.find((connection) => connection.id === connectionId) ?? null;
    const isUnas = selected?.kind === "unifi-unas";
    const segments = path ? path.split("/") : [];

    // Each connection opens on its natural tab: a UNAS on Hardware (its native
    // connection is metrics-only for now), a file store on Files.
    useEffect(() => {
        setView(isUnas ? "hardware" : "files");
    }, [connectionId, isUnas]);

    const load = useCallback(
        async (signal?: AbortSignal) => {
            setError(null);
            if (!connectionId) {
                setEntries([]);
                setMetrics(null);
                return;
            }
            if (view === "hardware" && isUnas) {
                const cacheKey = `polaris:unas:${connectionId}`;
                const cached = readCache<UnasMetricsData>(cacheKey, METRICS_TTL_MS);
                if (cached) {
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
            if (view === "files") {
                // File listings are not cached: freshness matters after uploads/deletes.
                // A UNAS browses over SMB (same account); if no share is set yet the
                // API asks us to prompt for it.
                setNeedsSmbShare(false);
                setLoading(true);
                try {
                    const query = new URLSearchParams({ c: connectionId });
                    if (path) query.set("p", path);
                    const res = await fetch(`/api/drive/list?${query.toString()}`, { signal });
                    const body = await res.json();
                    if (signal?.aborted) return;
                    if (body.needsSmbShare) {
                        setEntries([]);
                        setNeedsSmbShare(true);
                    } else if (!res.ok) {
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
            }
        },
        [connectionId, isUnas, path, view]
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

    function submitNewFolder(event: React.FormEvent) {
        event.preventDefault();
        const name = newFolderName.trim();
        if (!connectionId || !name) return;
        setNewFolderOpen(false);
        setNewFolderName("");
        startTransition(async () => {
            await mkdirAction(connectionId, path, name);
            void load();
        });
    }

    function confirmDelete() {
        if (!connectionId || !deleteTarget) return;
        const target = deleteTarget;
        setDeleteTarget(null);
        // Optimistic: drop the row now; a failed delete reloads the true listing.
        setEntries((prev) => prev.filter((entry) => entry.path !== target.path));
        startTransition(async () => {
            await deleteEntryAction(connectionId, target.path);
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
                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Add a storage connection to start browsing.
                    </div>
                ) : (
                    <>
                        <div className="mb-3 flex items-center gap-1 border-b border-border">
                            <TabButton active={view === "files"} onClick={() => setView("files")}>
                                Files
                            </TabButton>
                            <TabButton active={view === "hardware"} onClick={() => setView("hardware")}>
                                Hardware
                            </TabButton>
                        </div>

                        {view === "hardware" ? (
                            isUnas ? (
                                loading && !metrics ? (
                                    <MetricsSkeleton />
                                ) : error ? (
                                    <ErrorBox message={error} />
                                ) : metrics ? (
                                    <UnasMetrics metrics={metrics} />
                                ) : null
                            ) : selected ? (
                                <HardwarePanel connection={selected} />
                            ) : null
                        ) : needsSmbShare ? (
                            <UnasSmbSetup connectionId={connectionId} onSaved={() => void load()} />
                        ) : (
                            <FilesView
                                connectionId={connectionId}
                                segments={segments}
                                entries={entries}
                                loading={loading}
                                error={error}
                                pending={pending}
                                uploading={uploading}
                                fileInput={fileInput}
                                href={href}
                                onNewFolder={() => setNewFolderOpen(true)}
                                onUpload={onUpload}
                                onDelete={(entry) => setDeleteTarget(entry)}
                            />
                        )}
                    </>
                )}
            </section>

            <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>New folder</DialogTitle>
                        <DialogDescription>Create a folder in the current location.</DialogDescription>
                    </DialogHeader>
                    <form onSubmit={submitNewFolder} className="flex flex-col gap-3">
                        <Input
                            autoFocus
                            value={newFolderName}
                            onChange={(event) => setNewFolderName(event.target.value)}
                            placeholder="Folder name"
                        />
                        <div className="flex justify-end gap-2">
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={!newFolderName.trim()}>
                                Create
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete {deleteTarget?.kind === "dir" ? "folder" : "file"}</DialogTitle>
                        <DialogDescription className="truncate">
                            {deleteTarget?.name} will be permanently deleted
                            {deleteTarget?.kind === "dir" ? ", along with everything inside it" : ""}.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => setDeleteTarget(null)}>
                            Cancel
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmDelete}>
                            Delete
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
            )}
        >
            {children}
        </button>
    );
}

function ErrorBox({ message }: { message: string }) {
    return (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{message}</div>
    );
}

/**
 * One-time SMB share prompt for a UNAS: files live on the device's SMB share, and
 * the UNAS accepts the same UniFi account, so only the share name is needed - the
 * stored username/password are reused. Once saved, the Files tab browses over SMB.
 */
function UnasSmbSetup({ connectionId, onSaved }: { connectionId: string; onSaved: () => void }) {
    const [share, setShare] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: React.FormEvent) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await setUnasShareAction(connectionId, share);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onSaved();
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3 text-sm">
                    <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="flex flex-col gap-1">
                        <span className="font-medium">Browse UNAS files over SMB</span>
                        <span className="text-muted-foreground">
                            Files are served from the device&apos;s SMB share, using the same UniFi account you
                            already entered. Just tell Polaris the share name (enable SMB on the UNAS if it is not
                            already).
                        </span>
                    </div>
                </div>
                <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-1 flex-col gap-1 text-sm">
                        SMB share name
                        <input
                            className="h-9 rounded-md border border-input bg-surface px-3 text-sm"
                            value={share}
                            onChange={(event) => setShare(event.target.value)}
                            placeholder="e.g. share, data, home"
                            autoFocus
                        />
                    </label>
                    <Button type="submit" disabled={pending || !share.trim()}>
                        {pending ? "Connecting..." : "Connect"}
                    </Button>
                </form>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

function FilesView({
    connectionId,
    segments,
    entries,
    loading,
    error,
    pending,
    uploading,
    fileInput,
    href,
    onNewFolder,
    onUpload,
    onDelete
}: {
    connectionId: string;
    segments: string[];
    entries: DriveEntry[];
    loading: boolean;
    error: string | null;
    pending: boolean;
    uploading: boolean;
    fileInput: React.RefObject<HTMLInputElement | null>;
    href: (id: string, target: string) => string;
    onNewFolder: () => void;
    onUpload: (files: FileList | null) => void;
    onDelete: (entry: DriveEntry) => void;
}) {
    return (
        <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
                    <Link href={href(connectionId, "")} className="hover:text-foreground">
                        Home
                    </Link>
                    {segments.map((segment, index) => {
                        const target = segments.slice(0, index + 1).join("/");
                        return (
                            <span key={target} className="flex items-center gap-1">
                                <ChevronRight className="size-3" />
                                <Link href={href(connectionId, target)} className="truncate hover:text-foreground">
                                    {segment}
                                </Link>
                            </span>
                        );
                    })}
                </div>
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
            </div>

            {loading ? (
                <ListingSkeleton />
            ) : error ? (
                <ErrorBox message={error} />
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
                                                    onClick={() => onDelete(entry)}
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
        </>
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
