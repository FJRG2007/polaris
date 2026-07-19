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
import { Folder, HardDrive, Info, Trash2 } from "lucide-react";
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
    deleteConnectionAction,
    deleteEntryAction,
    discoverUnasSharesAction,
    mkdirAction,
    renameAction,
    setUnasShareAction
} from "./actions";
import { ConnectionDialog } from "./connection-dialog";
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
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [deleteTargets, setDeleteTargets] = useState<DriveEntry[] | null>(null);
    const [deleteConn, setDeleteConn] = useState<ConnectionSummary | null>(null);
    const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
    const [requestTarget, setRequestTarget] = useState<RequestTarget | null>(null);

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

    function confirmDelete() {
        if (!connectionId || !deleteTargets) return;
        const targets = deleteTargets;
        setDeleteTargets(null);
        const paths = new Set(targets.map((entry) => entry.path));
        setEntries((prev) => prev.filter((entry) => !paths.has(entry.path)));
        startTransition(async () => {
            for (const entry of targets) {
                await deleteEntryAction(connectionId, entry.path);
            }
            void load();
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
                                    {connection.requiresHostd ? <Badge variant="neutral">host</Badge> : null}
                                </Link>
                                <button
                                    type="button"
                                    onClick={() => setDeleteConn(connection)}
                                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                                    aria-label={`Remove ${connection.name}`}
                                >
                                    <Trash2 className="size-4" />
                                </button>
                            </div>
                        ))
                    )}
                </nav>
            </aside>

            <section className="min-w-0">
                {selectedConnection?.kind === "unifi-unas" ? (
                    <div className="mb-3 flex items-center justify-end">
                        <UnifiConsoleButton webUrl={selectedConnection.webUrl} />
                    </div>
                ) : null}

                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Add a storage connection to start browsing.
                    </div>
                ) : needsSmbShare ? (
                    <UnasSmbSetup connectionId={connectionId} onSaved={() => void load()} />
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
                    />
                )}
            </section>

            <ShareDialog target={shareTarget} onOpenChange={(open) => !open && setShareTarget(null)} />
            <RequestDialog target={requestTarget} onOpenChange={(open) => !open && setRequestTarget(null)} />

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

            <Dialog open={deleteTargets !== null} onOpenChange={(open) => !open && setDeleteTargets(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            Delete {deleteTargets && deleteTargets.length > 1 ? `${deleteTargets.length} items` : "item"}
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {deleteTargets && deleteTargets.length === 1
                                ? `${deleteTargets[0]?.name} will be permanently deleted${deleteTargets[0]?.kind === "dir" ? ", along with everything inside it" : ""}.`
                                : "The selected items will be permanently deleted, along with everything inside any folders."}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => setDeleteTargets(null)}>
                            Cancel
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmDelete}>
                            Delete
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
