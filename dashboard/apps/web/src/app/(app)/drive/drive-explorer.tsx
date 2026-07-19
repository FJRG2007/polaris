"use client";

/**
 * The Files browser: a connection rail on the left, a breadcrumb and file table
 * on the right for the selected NAS. Device metrics live on the Overview page;
 * this view is purely files. Navigation is URL-driven (?c=connection&p=path) so
 * it is linkable and the back button works. Content loads on the client behind a
 * skeleton so a slow NAS never stalls the whole navigation. A UNAS browses over
 * SMB, reusing its stored account; if no share is set yet it prompts to pick one,
 * and (being a UniFi device) it also offers a shortcut to its own console.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Folder, HardDrive, Info, Loader2, Pencil, ShieldCheck, Trash2 } from "lucide-react";
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
import {
    copyAction,
    createFileAction,
    deleteConnectionAction,
    discoverUnasSharesAction,
    mkdirAction,
    moveToTrashAction,
    renameAction,
    setItemFavoriteAction,
    setItemHiddenAction,
    setItemIconAction,
    setItemNoteAction,
    setUnasShareAction
} from "./actions";
import { AccessDialog, UnlockPanel, type AccessTarget } from "./access-dialog";
import { ConnectionDialog, EditConnectionDialog } from "./connection-dialog";
import { FilesView } from "./files-view";
import { RequestDialog, type RequestTarget } from "./request-dialog";
import { ShareDialog, type ShareTarget } from "./share-dialog";
import { UnifiConsoleButton } from "./unifi-console-button";
import type { ConnectionSummary, DriveEntry } from "./types";

/** Parent path of a relative path ("a/b/c" -> "a/b", "a" -> ""). */
function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
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
    const router = useRouter();
    const fileInput = useRef<HTMLInputElement>(null);
    const [pending, startTransition] = useTransition();
    const [uploading, setUploading] = useState(false);

    const [entries, setEntries] = useState<DriveEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [needsSmbShare, setNeedsSmbShare] = useState(false);
    const [locked, setLocked] = useState<{ lockId: string; lockPath: string } | null>(null);
    const [accessTarget, setAccessTarget] = useState<AccessTarget | null>(null);
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [newFileOpen, setNewFileOpen] = useState(false);
    const [newFileName, setNewFileName] = useState("Untitled.txt");
    const [deleteTargets, setDeleteTargets] = useState<DriveEntry[] | null>(null);
    const [deleteConn, setDeleteConn] = useState<ConnectionSummary | null>(null);
    const [editConn, setEditConn] = useState<ConnectionSummary | null>(null);
    const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
    const [requestTarget, setRequestTarget] = useState<RequestTarget | null>(null);
    const [ops, setOps] = useState<{ id: string; label: string }[]>([]);

    /** Run a mutating operation in the background: shows in the operations panel,
     * keeps the dashboard usable (a transition), and refreshes the listing after. */
    function runOp(label: string, fn: () => Promise<void>) {
        const id = crypto.randomUUID();
        setOps((prev) => [...prev, { id, label }]);
        startTransition(async () => {
            try {
                await fn();
            } finally {
                setOps((prev) => prev.filter((op) => op.id !== id));
                void load();
            }
        });
    }

    const segments = path ? path.split("/") : [];
    const selectedConnection = connections.find((connection) => connection.id === connectionId) ?? null;

    const load = useCallback(
        async (signal?: AbortSignal) => {
            setError(null);
            if (!connectionId) {
                setEntries([]);
                return;
            }
            setNeedsSmbShare(false);
            setLocked(null);
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
                } else if (body.locked) {
                    setEntries([]);
                    setLocked({ lockId: body.lockId, lockPath: body.lockPath });
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
        },
        [connectionId, path]
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

    async function onUpload(items: { file: File; relPath: string }[]) {
        if (!connectionId || items.length === 0) return;
        setUploading(true);
        // relPath may be nested (a/b/file.txt) for a folder upload; the route
        // creates the parent directories before writing.
        for (const { file, relPath } of items) {
            const query = new URLSearchParams({ c: connectionId, name: relPath });
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

    function onRename(entry: DriveEntry, nextName: string) {
        if (!connectionId) return;
        const parent = parentOf(entry.path);
        const to = parent ? `${parent}/${nextName}` : nextName;
        setEntries((prev) =>
            prev.map((row) => (row.path === entry.path ? { ...row, name: nextName, path: to } : row))
        );
        startTransition(async () => {
            await renameAction(connectionId, entry.path, to);
            void load();
        });
    }

    function onToggleHidden(entry: DriveEntry) {
        if (!connectionId) return;
        const next = !entry.hidden;
        setEntries((prev) => prev.map((row) => (row.path === entry.path ? { ...row, hidden: next } : row)));
        startTransition(async () => {
            await setItemHiddenAction(connectionId, entry.path, next);
            void load();
        });
    }

    function onSetFavorite(entry: DriveEntry, favorite: boolean) {
        if (!connectionId) return;
        setEntries((prev) => prev.map((row) => (row.path === entry.path ? { ...row, favorite } : row)));
        startTransition(async () => {
            await setItemFavoriteAction(connectionId, entry.path, favorite);
            void load();
        });
    }

    function onSetIcon(entry: DriveEntry, icon: string | null, color: string | null) {
        if (!connectionId) return;
        setEntries((prev) =>
            prev.map((row) => (row.path === entry.path ? { ...row, icon, iconColor: color } : row))
        );
        startTransition(async () => {
            await setItemIconAction(connectionId, entry.path, icon, color);
            void load();
        });
    }

    function submitNewFile(event: React.FormEvent) {
        event.preventDefault();
        const name = newFileName.trim();
        if (!connectionId || !name) return;
        setNewFileOpen(false);
        setNewFileName("Untitled.txt");
        runOp(`Creating ${name}`, () => createFileAction(connectionId, path, name));
    }

    function onSetNote(entry: DriveEntry, note: string | null) {
        if (!connectionId) return;
        setEntries((prev) => prev.map((row) => (row.path === entry.path ? { ...row, note } : row)));
        startTransition(async () => {
            await setItemNoteAction(connectionId, entry.path, note);
            void load();
        });
    }

    function onMove(entry: DriveEntry, destFolderPath: string) {
        if (!connectionId) return;
        const to = destFolderPath ? `${destFolderPath}/${entry.name}` : entry.name;
        setEntries((prev) => prev.filter((row) => row.path !== entry.path));
        runOp(`Moving ${entry.name}`, () => renameAction(connectionId, entry.path, to));
    }

    function onCopy(entry: DriveEntry, destFolderPath: string) {
        if (!connectionId) return;
        runOp(`Copying ${entry.name}`, () => copyAction(connectionId, entry.path, destFolderPath));
    }

    function confirmDelete() {
        if (!connectionId || !deleteTargets) return;
        const targets = deleteTargets;
        setDeleteTargets(null);
        const paths = new Set(targets.map((entry) => entry.path));
        setEntries((prev) => prev.filter((entry) => !paths.has(entry.path)));
        const label =
            targets.length === 1
                ? `Moving ${targets[0]?.name} to Trash`
                : `Moving ${targets.length} items to Trash`;
        runOp(label, async () => {
            for (const entry of targets) {
                await moveToTrashAction(connectionId, entry.path);
            }
        });
    }

    function confirmDeleteConnection() {
        if (!deleteConn) return;
        const target = deleteConn;
        setDeleteConn(null);
        startTransition(async () => {
            await deleteConnectionAction(target.id);
            router.push("/drive");
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
                            <div key={connection.id} className="group flex items-center gap-1">
                                <Link
                                    href={href(connection.id, "")}
                                    className={cn(
                                        "flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                                        connection.id === connectionId && "bg-muted font-medium"
                                    )}
                                >
                                    <HardDrive className="size-4 text-muted-foreground" />
                                    <span className="flex-1 truncate">{connection.name}</span>
                                    {connection.shared ? <Badge variant="neutral">shared</Badge> : null}
                                    {connection.requiresHostd ? <Badge variant="neutral">host</Badge> : null}
                                </Link>
                                {connection.canManageAccess ? (
                                    <button
                                        type="button"
                                        onClick={() => setEditConn(connection)}
                                        className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                                        aria-label={`Edit ${connection.name}`}
                                    >
                                        <Pencil className="size-4" />
                                    </button>
                                ) : null}
                                {connection.canManageAccess ? (
                                    <button
                                        type="button"
                                        onClick={() => setDeleteConn(connection)}
                                        className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                                        aria-label={`Remove ${connection.name}`}
                                    >
                                        <Trash2 className="size-4" />
                                    </button>
                                ) : null}
                            </div>
                        ))
                    )}
                </nav>
            </aside>

            <section className="min-w-0">
                {connectionId && (selectedConnection?.kind === "unifi-unas" || selectedConnection?.canManageAccess) ? (
                    <div className="mb-3 flex items-center justify-end gap-2">
                        {selectedConnection?.canManageAccess ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    setAccessTarget({
                                        connectionId,
                                        path,
                                        name: segments[segments.length - 1] ?? selectedConnection?.name ?? "This folder"
                                    })
                                }
                            >
                                <ShieldCheck className="size-4" />
                                Access
                            </Button>
                        ) : null}
                        {selectedConnection?.kind === "unifi-unas" ? (
                            <UnifiConsoleButton webUrl={selectedConnection.webUrl} />
                        ) : null}
                    </div>
                ) : null}

                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Add a storage connection to start browsing.
                    </div>
                ) : needsSmbShare ? (
                    <UnasSmbSetup connectionId={connectionId} onSaved={() => void load()} />
                ) : locked ? (
                    <UnlockPanel
                        connectionId={connectionId}
                        lockId={locked.lockId}
                        lockPath={locked.lockPath}
                        onUnlocked={() => void load()}
                    />
                ) : (
                    <FilesView
                        connectionId={connectionId}
                        path={path}
                        segments={segments}
                        entries={entries}
                        loading={loading}
                        error={error}
                        pending={pending}
                        uploading={uploading}
                        fileInput={fileInput}
                        href={href}
                        onNewFolder={() => setNewFolderOpen(true)}
                        onNewFile={() => setNewFileOpen(true)}
                        onUpload={onUpload}
                        onDelete={(items) => setDeleteTargets(items)}
                        onRename={onRename}
                        onShare={(entry) =>
                            setShareTarget({
                                connectionId,
                                path: entry.path,
                                name: entry.name,
                                isDir: entry.kind === "dir"
                            })
                        }
                        onRequestFiles={(target, name) =>
                            setRequestTarget({ connectionId, path: target, name })
                        }
                        onToggleHidden={onToggleHidden}
                        onSetFavorite={onSetFavorite}
                        onSetIcon={onSetIcon}
                        onSetNote={onSetNote}
                        onMove={onMove}
                        onCopy={onCopy}
                        onManageAccess={
                            selectedConnection?.canManageAccess
                                ? (entry) =>
                                      setAccessTarget({ connectionId, path: entry.path, name: entry.name })
                                : undefined
                        }
                    />
                )}
            </section>

            {ops.length > 0 ? (
                <div className="fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-lg">
                    <p className="text-xs font-medium text-muted-foreground">Working in the background</p>
                    {ops.map((op) => (
                        <div key={op.id} className="flex items-center gap-2 text-sm">
                            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                            <span className="truncate">{op.label}</span>
                        </div>
                    ))}
                </div>
            ) : null}

            <ShareDialog target={shareTarget} onOpenChange={(open) => !open && setShareTarget(null)} />
            <RequestDialog target={requestTarget} onOpenChange={(open) => !open && setRequestTarget(null)} />
            <AccessDialog
                target={accessTarget}
                onOpenChange={(open) => !open && setAccessTarget(null)}
                onChanged={() => void load()}
            />
            <EditConnectionDialog
                connection={editConn}
                open={editConn !== null}
                onOpenChange={(open) => !open && setEditConn(null)}
            />

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

            <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>New file</DialogTitle>
                        <DialogDescription>
                            Create an empty file here. Use any extension (e.g. .txt, .md, .json).
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={submitNewFile} className="flex flex-col gap-3">
                        <Input
                            autoFocus
                            value={newFileName}
                            onChange={(event) => setNewFileName(event.target.value)}
                            placeholder="Untitled.txt"
                        />
                        <div className="flex justify-end gap-2">
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={!newFileName.trim()}>
                                Create
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog open={deleteTargets !== null} onOpenChange={(open) => !open && setDeleteTargets(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            Move {deleteTargets && deleteTargets.length > 1 ? `${deleteTargets.length} items` : "item"}{" "}
                            to Trash
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {deleteTargets && deleteTargets.length === 1
                                ? `${deleteTargets[0]?.name} will be moved to the recycle bin. You can restore it from Trash.`
                                : "The selected items will be moved to the recycle bin. You can restore them from Trash."}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => setDeleteTargets(null)}>
                            Cancel
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmDelete}>
                            Move to Trash
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={deleteConn !== null} onOpenChange={(open) => !open && setDeleteConn(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Remove connection</DialogTitle>
                        <DialogDescription>
                            {deleteConn?.name} will be removed from Polaris. The device itself and its data are not
                            touched - you can add it again anytime.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => setDeleteConn(null)}>
                            Cancel
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmDeleteConnection}>
                            Remove
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/**
 * One-time SMB share prompt for a UNAS: Polaris auto-discovers the device's shares
 * (reusing the stored UniFi account) so the user picks one; a manual field is the
 * fallback, defaulting to the UNAS Pro's out-of-the-box "Personal-Drive".
 */
function UnasSmbSetup({ connectionId, onSaved }: { connectionId: string; onSaved: () => void }) {
    const [share, setShare] = useState("Personal-Drive");
    const [shares, setShares] = useState<string[] | null>(null);
    const [discovering, setDiscovering] = useState(true);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        setDiscovering(true);
        setError(null);
        discoverUnasSharesAction(connectionId).then((result) => {
            if (!active) return;
            setDiscovering(false);
            if (result.error) setError(result.error);
            setShares(result.shares ?? []);
        });
        return () => {
            active = false;
        };
    }, [connectionId]);

    async function choose(name: string) {
        if (!name.trim()) return;
        setPending(true);
        setError(null);
        const result = await setUnasShareAction(connectionId, name);
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
                            already entered. Pick the share to open.
                        </span>
                    </div>
                </div>

                {discovering ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Skeleton className="h-8 w-24" />
                        <Skeleton className="h-8 w-24" />
                        <span>Detecting shares...</span>
                    </div>
                ) : shares && shares.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {shares.map((name) => (
                            <Button
                                key={name}
                                type="button"
                                variant="secondary"
                                disabled={pending}
                                onClick={() => choose(name)}
                            >
                                <Folder className="size-4" />
                                {name}
                            </Button>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        No shares were detected automatically. Enter the share name below (enable SMB on the UNAS if
                        it is off).
                    </p>
                )}

                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void choose(share);
                    }}
                    className="flex flex-wrap items-end gap-2"
                >
                    <label className="flex flex-1 flex-col gap-1 text-sm">
                        Or type a share name
                        <input
                            className="h-9 rounded-md border border-input bg-surface px-3 text-sm"
                            value={share}
                            onChange={(event) => setShare(event.target.value)}
                            placeholder="e.g. Personal-Drive, data, home"
                        />
                    </label>
                    <Button type="submit" variant="ghost" disabled={pending || !share.trim()}>
                        {pending ? "Connecting..." : "Connect"}
                    </Button>
                </form>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
