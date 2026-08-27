"use client";

/**
 * The Files browser: a connection rail on the left, a breadcrumb and file table
 * on the right for the selected NAS. Device metrics live on the Overview page;
 * this view is purely files. Navigation is URL-driven (?c=connection&p=path) so
 * it is linkable and the back button works. Content loads on the client behind a
 * skeleton so a slow NAS never stalls the whole navigation. A UNAS browses over
 * SMB, reusing its stored account; if no share is set yet it prompts to pick one,
 * and (being a UniFi device) it also offers a shortcut to its own console.
 *
 * Sources are polled for reachability, because a machine that is off answers a
 * browse with a connect timeout and then a generic failure: one that is down is
 * marked in the rail, cannot be opened, and is never asked for its files.
 *
 * Only one listing request is ever in flight. Moving to another source calls off
 * the request the previous one had not answered - along with any prefetch left
 * over from the cursor passing its row - so a device that is not answering holds
 * up nothing but itself.
 */

import Link from "next/link";
import { FilesView } from "./files-view";
import * as driveActions from "./actions";
import { useRouter } from "next/navigation";
import { UnifiConsoleButton } from "./unifi-console-button";
import { ShareDialog, type ShareTarget } from "./share-dialog";
import { PeopleShareDialog, type PeopleShareTarget } from "./people-share-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { RemoveConnectionDialog } from "./remove-connection-dialog";
import { RequestDialog, type RequestTarget } from "./request-dialog";
import { ConnectionDialog, EditConnectionDialog } from "./connection-dialog";
import { AccessDialog, UnlockPanel, type AccessTarget } from "./access-dialog";
import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import {
    abortPrefetchesOutside,
    dropDriveSnapshots,
    prefetchListing,
    readListing,
    writeListing
} from "./listing-cache";
import {
    isSavedConnection,
    mayBeUnreachable,
    type ConnectionSummary,
    type DriveEntry,
    type SourceStatus
} from "./types";
import {
    AlertTriangle,
    Folder,
    FolderHeart,
    HardDrive,
    Info,
    KeyRound,
    Loader2,
    Pencil,
    RefreshCw,
    ShieldCheck,
    Trash2,
    X
} from "lucide-react";
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

/** How often the machines behind the sources are re-checked. One short-lived
 *  socket per source, and a device going down is worth noticing while the
 *  browser is open on its files. */
const SOURCE_POLL_MS = 30_000;

/** Parent path of a relative path ("a/b/c" -> "a/b", "a" -> ""). */
function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
}

/** Every rendered field of an entry, so an equal signature means an equal row. */
function entrySignature(entry: DriveEntry): string {
    return [
        entry.kind,
        entry.size,
        entry.modifiedAt,
        entry.createdAt,
        entry.name,
        entry.hidden ?? false,
        entry.favorite ?? false,
        entry.icon ?? "",
        entry.iconColor ?? "",
        entry.note ?? "",
        entry.owner ?? "",
        entry.locked ?? false
    ].join("");
}

/**
 * Whether two listings are identical (same items, same fields), order-insensitive -
 * the visible order is derived client-side. Used to skip a no-op state update after a
 * mutation: the optimistic list already matches what the server returns, so replacing
 * the array (which re-renders every row) would just be a visible "reload" of unchanged
 * data. Returning the same reference instead lets React bail out of the render.
 */
function listingsEqual(a: DriveEntry[], b: DriveEntry[]): boolean {
    if (a.length !== b.length) return false;
    const byPath = new Map<string, string>();
    for (const entry of a) byPath.set(entry.path, entrySignature(entry));
    for (const entry of b) {
        const signature = byPath.get(entry.path);
        if (signature === undefined || signature !== entrySignature(entry)) return false;
    }
    return true;
}

export function DriveExplorer({
    connections,
    connectionId,
    path,
    notice
}: {
    connections: ConnectionSummary[];
    connectionId: string | null;
    path: string;
    /** Something the page worked out before this rendered and could not act on -
     *  shown in the same corner a failed operation is, and dismissed the same way. */
    notice?: string;
}) {
    const router = useRouter();
    const fileInput = useRef<HTMLInputElement>(null);
    /** The listing request in flight. There is only ever one: a new location, or a
     *  refresh after a write, calls off the one before it instead of racing it. */
    const listing = useRef<AbortController | null>(null);
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
    const [permanentTargets, setPermanentTargets] = useState<DriveEntry[] | null>(null);
    const [emptyTarget, setEmptyTarget] = useState<{
        entry: DriveEntry;
        permanent: boolean;
    } | null>(null);
    const [scheduleTargets, setScheduleTargets] = useState<DriveEntry[] | null>(null);
    const [deleteConn, setDeleteConn] = useState<ConnectionSummary | null>(null);
    const [editConn, setEditConn] = useState<ConnectionSummary | null>(null);
    const [shareTargets, setShareTargets] = useState<ShareTarget[] | null>(null);
    const [peopleTarget, setPeopleTarget] = useState<PeopleShareTarget | null>(null);
    const [requestTarget, setRequestTarget] = useState<RequestTarget | null>(null);
    const [ops, setOps] = useState<{ id: string; label: string }[]>([]);
    const [opError, setOpError] = useState<string | null>(notice ?? null);

    /** Run a mutating operation in the background: shows in the operations panel,
     * keeps the dashboard usable (a transition), and refreshes the listing after.
     * A structured or thrown error surfaces in a banner instead of failing silently. */
    function runOp(label: string, fn: () => Promise<{ error?: string } | void>) {
        const id = crypto.randomUUID();
        setOpError(null);
        setOps((prev) => [...prev, { id, label }]);
        startTransition(async () => {
            try {
                const result = await fn();
                if (result && typeof result === "object" && result.error) setOpError(result.error);
            } catch (caught) {
                setOpError(
                    caught instanceof Error && caught.message ? caught.message : `${label} failed`
                );
            } finally {
                setOps((prev) => prev.filter((op) => op.id !== id));
                // A write can change a folder other than the one on screen (a move
                // or a copy has a destination), so no cached read is trusted
                // after one.
                dropDriveSnapshots();
                void load();
            }
        });
    }

    const segments = path ? path.split("/") : [];
    const selectedConnection =
        connections.find((connection) => connection.id === connectionId) ?? null;

    // Whether the sources in the rail are answering. Polled only when one of them
    // points at a machine: an instance browsing a bucket and a local folder has
    // nothing that can be off, and the poll would be a request that can never say
    // anything.
    const {
        data: reachability,
        refreshing: rechecking,
        refresh: recheckSources
    } = useLiveResource<SourceStatus[]>({
        url: "/api/drive/source-status",
        cacheKey: "drive.source-status",
        intervalMs: SOURCE_POLL_MS,
        enabled: connections.some(mayBeUnreachable),
        select: (body) => (body as { sources: SourceStatus[] }).sources
    });

    /** Why a source cannot be reached right now, or null while it answers - and
     *  while the answer is still on its way, which is not the same as down. */
    const downReason = useCallback(
        (id: string | null): string | null => {
            if (!id || !reachability) return null;
            const status = reachability.find((entry) => entry.id === id);
            return status?.state === "down" ? (status.detail ?? "No answer") : null;
        },
        [reachability]
    );
    const unreachable = downReason(connectionId);
    const anyDown = connections.some((connection) => downReason(connection.id) !== null);

    const load = useCallback(
        // `showSkeleton` blanks the list to a skeleton while fetching - right for a
        // navigation (new location), wrong for a background refresh after a mutation
        // (rename/move/delete), where the optimistic list is already correct and a
        // skeleton flash just looks like a needless reload. Refreshes pass it false.
        async (showSkeleton = false) => {
            // Whatever the last location was still waiting for, nobody is waiting
            // for it now. Calling it off is what keeps a source that never answered
            // from holding the skeleton over the source that did.
            listing.current?.abort();
            const controller = new AbortController();
            listing.current = controller;
            const { signal } = controller;
            setError(null);
            if (!connectionId) {
                setEntries([]);
                setLoading(false);
                return;
            }
            // A folder visited moments ago (or prefetched on the way to it) paints
            // now and is corrected by the answer below, so a navigation costs a
            // remote listing but does not wait for one.
            const cached = showSkeleton ? readListing(connectionId, path) : null;
            if (cached) setEntries(cached);
            // Assigned, not raised: this location decides whether a skeleton is on
            // screen, including when the one before it left one there.
            if (showSkeleton) setLoading(!cached);
            // A server that is not answering would take the connect timeout to
            // fail and come back as a generic error. The panel already says what
            // is wrong, so the request is not made at all.
            if (unreachable) {
                setEntries([]);
                setLoading(false);
                return;
            }
            setNeedsSmbShare(false);
            setLocked(null);
            try {
                const query = new URLSearchParams({ c: connectionId });
                if (path) query.set("p", path);
                const res = await fetch(`/api/drive/list?${query.toString()}`, { signal });
                const body = await res.json();
                if (signal.aborted) return;
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
                    // Keep the current array (no re-render) when nothing actually
                    // changed - e.g. a background refresh after an optimistic rename
                    // or delete that already brought the list to this exact state.
                    const next = body.entries as DriveEntry[];
                    setEntries((prev) => (listingsEqual(prev, next) ? prev : next));
                    writeListing(connectionId, path, next);
                }
            } catch {
                if (!signal.aborted) setError("Unable to list this location");
            } finally {
                if (!signal.aborted) setLoading(false);
            }
        },
        [connectionId, path, unreachable]
    );

    useEffect(() => {
        // A location change shows the skeleton; background refreshes (mutations) do not.
        void load(true);
        // Guesses made about other sources while the cursor crossed their rows are
        // not worth a connection now that this one is being read.
        if (connectionId) abortPrefetchesOutside(connectionId);
        return () => listing.current?.abort();
    }, [load, connectionId]);

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
        runOp(`Creating ${name}`, () => driveActions.mkdirAction(connectionId, path, name));
    }

    function onRename(entry: DriveEntry, nextName: string) {
        if (!connectionId) return;
        const parent = parentOf(entry.path);
        const to = parent ? `${parent}/${nextName}` : nextName;
        setEntries((prev) =>
            prev.map((row) =>
                row.path === entry.path ? { ...row, name: nextName, path: to } : row
            )
        );
        setOpError(null);
        startTransition(async () => {
            const result = await driveActions.renameAction(connectionId, entry.path, to);
            if (result?.error) setOpError(result.error);
            void load();
        });
    }

    function onToggleHidden(entry: DriveEntry) {
        if (!connectionId) return;
        const next = !entry.hidden;
        setEntries((prev) =>
            prev.map((row) => (row.path === entry.path ? { ...row, hidden: next } : row))
        );
        startTransition(async () => {
            await driveActions.setItemHiddenAction(connectionId, entry.path, next);
            void load();
        });
    }

    function onSetFavorite(entry: DriveEntry, favorite: boolean) {
        if (!connectionId) return;
        setEntries((prev) =>
            prev.map((row) => (row.path === entry.path ? { ...row, favorite } : row))
        );
        startTransition(async () => {
            await driveActions.setItemFavoriteAction(connectionId, entry.path, favorite);
            void load();
        });
    }

    function onSetIcon(entry: DriveEntry, icon: string | null, color: string | null) {
        if (!connectionId) return;
        setEntries((prev) =>
            prev.map((row) => (row.path === entry.path ? { ...row, icon, iconColor: color } : row))
        );
        startTransition(async () => {
            await driveActions.setItemIconAction(connectionId, entry.path, icon, color);
            void load();
        });
    }

    function submitNewFile(event: React.FormEvent) {
        event.preventDefault();
        const name = newFileName.trim();
        if (!connectionId || !name) return;
        setNewFileOpen(false);
        setNewFileName("Untitled.txt");
        runOp(`Creating ${name}`, () => driveActions.createFileAction(connectionId, path, name));
    }

    function onSetNote(entry: DriveEntry, note: string | null) {
        if (!connectionId) return;
        setEntries((prev) => prev.map((row) => (row.path === entry.path ? { ...row, note } : row)));
        startTransition(async () => {
            await driveActions.setItemNoteAction(connectionId, entry.path, note);
            void load();
        });
    }

    function onMove(entry: DriveEntry, destFolderPath: string) {
        if (!connectionId) return;
        const to = destFolderPath ? `${destFolderPath}/${entry.name}` : entry.name;
        // Already in that folder: nothing to do (dropping onto the current folder
        // or its own parent would otherwise flash the row out and back).
        if (to === entry.path) return;
        setEntries((prev) => prev.filter((row) => row.path !== entry.path));
        runOp(`Moving ${entry.name}`, () =>
            driveActions.moveIntoAction(connectionId, entry.path, destFolderPath)
        );
    }

    function onCopy(entry: DriveEntry, destFolderPath: string) {
        if (!connectionId) return;
        runOp(`Copying ${entry.name}`, () =>
            driveActions.copyAction(connectionId, entry.path, destFolderPath)
        );
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
        // The first refusal stops the run and is what gets reported. Carrying on
        // would leave the banner naming one failure while others went unmentioned,
        // and the listing reload in runOp puts back whatever did not move.
        runOp(label, async () => {
            for (const entry of targets) {
                const result = await driveActions.moveToTrashAction(connectionId, entry.path);
                if (result.error) return result;
            }
        });
    }

    function confirmDeletePermanent() {
        if (!connectionId || !permanentTargets) return;
        const targets = permanentTargets;
        setPermanentTargets(null);
        const paths = new Set(targets.map((entry) => entry.path));
        setEntries((prev) => prev.filter((entry) => !paths.has(entry.path)));
        const label =
            targets.length === 1
                ? `Deleting ${targets[0]?.name} permanently`
                : `Deleting ${targets.length} items permanently`;
        runOp(label, async () => {
            for (const entry of targets) {
                const result = await driveActions.deleteEntryAction(connectionId, entry.path);
                if (result.error) return result;
            }
        });
    }

    function confirmEmpty() {
        if (!connectionId || !emptyTarget) return;
        const { entry, permanent } = emptyTarget;
        setEmptyTarget(null);
        const label = permanent ? `Emptying ${entry.name}` : `Emptying ${entry.name} to Trash`;
        runOp(label, () => driveActions.emptyFolderAction(connectionId, entry.path, permanent));
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
            <aside className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium text-muted-foreground">Locations</h2>
                    <div className="flex items-center gap-1">
                        {anyDown ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={recheckSources}
                                disabled={rechecking}
                                title="Check again"
                                aria-label="Check the sources that are not answering"
                            >
                                <RefreshCw className={cn("size-4", rechecking && "animate-spin")} />
                            </Button>
                        ) : null}
                        <ConnectionDialog />
                    </div>
                </div>
                <nav className="flex flex-col gap-1">
                    {connections.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No connections yet.</p>
                    ) : (
                        connections.map((connection) => (
                            <div key={connection.id} className="group flex items-center gap-1">
                                {downReason(connection.id) ? (
                                    // Off, so there is nothing to open: browsing it
                                    // would only spend its connect timeout to say so.
                                    <span
                                        aria-disabled="true"
                                        title={`Not answering: ${downReason(connection.id)}`}
                                        className="flex flex-1 cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                                    >
                                        <ConnectionLabel
                                            connection={connection}
                                            down={downReason(connection.id)}
                                        />
                                    </span>
                                ) : (
                                    <Link
                                        href={href(connection.id, connection.rootPath ?? "")}
                                        // The root of a source somebody is reaching
                                        // for, fetched while they are still reaching.
                                        onPointerEnter={() =>
                                            prefetchListing(connection.id, connection.rootPath ?? "")
                                        }
                                        onFocus={() =>
                                            prefetchListing(connection.id, connection.rootPath ?? "")
                                        }
                                        className={cn(
                                            "flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                                            connection.id === connectionId && "bg-muted font-medium"
                                        )}
                                    >
                                        <ConnectionLabel connection={connection} down={null} />
                                    </Link>
                                )}
                                {connection.canManageAccess && connection.needsRekey ? (
                                    <button
                                        type="button"
                                        onClick={() => setEditConn(connection)}
                                        className="rounded-md p-1 text-warning transition-colors hover:bg-warning/10"
                                        aria-label={`Update credentials for ${connection.name}`}
                                        title="Update credentials"
                                    >
                                        <KeyRound className="size-4" />
                                    </button>
                                ) : null}
                                {connection.editable ? (
                                    <button
                                        type="button"
                                        onClick={() => setEditConn(connection)}
                                        className="rounded-md p-1 text-muted-foreground transition-opacity hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                                        aria-label={`Edit ${connection.name}`}
                                    >
                                        <Pencil className="size-4" />
                                    </button>
                                ) : null}
                                {connection.editable ? (
                                    <button
                                        type="button"
                                        onClick={() => setDeleteConn(connection)}
                                        className="rounded-md p-1 text-muted-foreground transition-opacity hover:text-danger md:opacity-0 md:group-hover:opacity-100"
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
                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Add a storage connection to start browsing.
                    </div>
                ) : unreachable ? (
                    <UnreachableServer
                        name={selectedConnection?.name ?? "This server"}
                        detail={unreachable}
                        onRecheck={recheckSources}
                    />
                ) : selectedConnection?.needsRekey ? (
                    <div className="rounded-md border border-warning/40 bg-warning/10 p-6">
                        <div className="flex items-start gap-3">
                            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
                            <div className="flex flex-col gap-2">
                                <h3 className="text-sm font-medium">
                                    Saved credentials need updating
                                </h3>
                                <p className="text-sm text-muted-foreground">
                                    This connection&apos;s credentials were encrypted with a
                                    different master key and can no longer be read. Enter the
                                    password (or key) again to restore access - your files, shares,
                                    ACLs, and settings are all kept.
                                </p>
                                {selectedConnection.canManageAccess ? (
                                    <div>
                                        <Button
                                            size="sm"
                                            onClick={() => setEditConn(selectedConnection)}
                                            className="mt-1"
                                        >
                                            <KeyRound className="size-4" />
                                            Update credentials
                                        </Button>
                                    </div>
                                ) : (
                                    <p className="text-xs text-muted-foreground">
                                        Ask the owner to update this connection&apos;s credentials.
                                    </p>
                                )}
                            </div>
                        </div>
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
                        rootPath={selectedConnection?.rootPath ?? ""}
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
                        onDeletePermanent={(items) => setPermanentTargets(items)}
                        onEmptyFolder={(entry, permanent) => setEmptyTarget({ entry, permanent })}
                        onScheduleDelete={(items) => setScheduleTargets(items)}
                        onRename={onRename}
                        onShare={
                            isSavedConnection(connectionId)
                                ? (items) =>
                                      setShareTargets(
                                          items.map((entry) => ({
                                              connectionId,
                                              path: entry.path,
                                              name: entry.name,
                                              isDir: entry.kind === "dir"
                                          }))
                                      )
                                : undefined
                        }
                        onShareFolder={
                            isSavedConnection(connectionId)
                                ? () =>
                                      setShareTargets([
                                          {
                                              connectionId,
                                              path,
                                              name:
                                                  segments[segments.length - 1] ??
                                                  selectedConnection?.name ??
                                                  "This folder",
                                              isDir: true
                                          }
                                      ])
                                : undefined
                        }
                        onSharePeople={
                            selectedConnection?.canManageAccess
                                ? (entry) =>
                                      setPeopleTarget({
                                          connectionId,
                                          path: entry.path,
                                          name: entry.name,
                                          isDir: entry.kind === "dir"
                                      })
                                : undefined
                        }
                        onSharePeopleFolder={
                            selectedConnection?.canManageAccess
                                ? () =>
                                      setPeopleTarget({
                                          connectionId,
                                          path,
                                          name:
                                              segments[segments.length - 1] ??
                                              selectedConnection?.name ??
                                              "This folder",
                                          isDir: true
                                      })
                                : undefined
                        }
                        onRequestFiles={
                            isSavedConnection(connectionId)
                                ? (target, name) =>
                                      setRequestTarget({ connectionId, path: target, name })
                                : undefined
                        }
                        onToggleHidden={onToggleHidden}
                        onSetFavorite={onSetFavorite}
                        onSetIcon={onSetIcon}
                        onSetNote={onSetNote}
                        onMove={onMove}
                        onCopy={onCopy}
                        onSaved={() => void load()}
                        onManageAccess={
                            selectedConnection?.canManageAccess
                                ? (entry) =>
                                      setAccessTarget({
                                          connectionId,
                                          path: entry.path,
                                          name: entry.name
                                      })
                                : undefined
                        }
                        headerActions={
                            selectedConnection?.canManageAccess ||
                            selectedConnection?.kind === "unifi-unas" ? (
                                <>
                                    {selectedConnection?.canManageAccess ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() =>
                                                setAccessTarget({
                                                    connectionId,
                                                    path,
                                                    name:
                                                        segments[segments.length - 1] ??
                                                        selectedConnection?.name ??
                                                        "This folder"
                                                })
                                            }
                                            title="Access"
                                            aria-label="Access"
                                        >
                                            <ShieldCheck className="size-4" />
                                            <span className="hidden sm:inline">Access</span>
                                        </Button>
                                    ) : null}
                                    {selectedConnection?.kind === "unifi-unas" ? (
                                        <UnifiConsoleButton webUrl={selectedConnection.webUrl} />
                                    ) : null}
                                </>
                            ) : undefined
                        }
                    />
                )}
            </section>

            {ops.length > 0 ? (
                <div className="fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2 rounded-lg border border-border-strong bg-elevated p-3 shadow-popover">
                    <p className="text-xs font-medium text-muted-foreground">
                        Working in the background
                    </p>
                    {ops.map((op) => (
                        <div key={op.id} className="flex items-center gap-2 text-sm">
                            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                            <span className="truncate">{op.label}</span>
                        </div>
                    ))}
                </div>
            ) : null}

            {opError ? (
                <div className="fixed bottom-4 right-4 z-50 flex w-80 items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger shadow-popover">
                    <Info className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{opError}</span>
                    <button
                        type="button"
                        onClick={() => setOpError(null)}
                        className="shrink-0 rounded p-0.5 hover:bg-danger/10"
                        aria-label="Dismiss"
                    >
                        <X className="size-4" />
                    </button>
                </div>
            ) : null}

            <ShareDialog
                targets={shareTargets}
                onOpenChange={(open) => !open && setShareTargets(null)}
            />
            <PeopleShareDialog
                target={peopleTarget}
                onOpenChange={(open) => !open && setPeopleTarget(null)}
                onChanged={() => void load()}
            />
            <RequestDialog
                target={requestTarget}
                onOpenChange={(open) => !open && setRequestTarget(null)}
            />
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
                        <DialogDescription>
                            Create a folder in the current location.
                        </DialogDescription>
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

            <Dialog
                open={deleteTargets !== null}
                onOpenChange={(open) => !open && setDeleteTargets(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            Move{" "}
                            {deleteTargets && deleteTargets.length > 1
                                ? `${deleteTargets.length} items`
                                : "item"}{" "}
                            to Trash
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {deleteTargets && deleteTargets.length === 1
                                ? `${deleteTargets[0]?.name} will be moved to the recycle bin. You can restore it from Trash.`
                                : "The selected items will be moved to the recycle bin. You can restore them from Trash."}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setDeleteTargets(null)}
                        >
                            Cancel
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmDelete}>
                            Move to Trash
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog
                open={emptyTarget !== null}
                onOpenChange={(open) => !open && setEmptyTarget(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {emptyTarget?.permanent
                                ? "Empty folder permanently"
                                : "Empty folder to Trash"}
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {emptyTarget
                                ? emptyTarget.permanent
                                    ? `Everything inside ${emptyTarget.entry.name} will be permanently deleted. The folder itself is kept. This cannot be undone.`
                                    : `Everything inside ${emptyTarget.entry.name} will be moved to the recycle bin. The folder itself is kept. You can restore items from Trash.`
                                : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => setEmptyTarget(null)}>
                            Cancel
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmEmpty}>
                            {emptyTarget?.permanent ? "Empty permanently" : "Empty to Trash"}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog
                open={permanentTargets !== null}
                onOpenChange={(open) => !open && setPermanentTargets(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            Delete{" "}
                            {permanentTargets && permanentTargets.length > 1
                                ? `${permanentTargets.length} items`
                                : "item"}{" "}
                            permanently
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {permanentTargets && permanentTargets.length === 1
                                ? `${permanentTargets[0]?.name} will be deleted for good. This cannot be undone.`
                                : "The selected items will be deleted for good. This cannot be undone."}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setPermanentTargets(null)}
                        >
                            Cancel
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmDeletePermanent}>
                            Delete permanently
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            {connectionId ? (
                <ScheduleDeleteDialog
                    connectionId={connectionId}
                    targets={scheduleTargets}
                    onOpenChange={(open) => !open && setScheduleTargets(null)}
                    onScheduled={() => {
                        setScheduleTargets(null);
                        void load();
                    }}
                    onError={(message) => setOpError(message)}
                />
            ) : null}

            <RemoveConnectionDialog
                connection={deleteConn}
                onClose={() => setDeleteConn(null)}
                onRemoved={(result) => {
                    // The connection is gone, and with it the location the browser
                    // was on. Anything the removal could not finish rides along to
                    // the page it lands on rather than disappearing with the dialog;
                    // what went right needs no notice, the files are simply there.
                    const warnings = result.warnings ?? [];
                    if (warnings.length > 0) setOpError(warnings.join(" "));
                    router.push("/drive");
                    router.refresh();
                }}
            />
        </div>
    );
}

/**
 * Icon, name and state of one source in the rail - the same whether the row opens
 * it or, when the device is not answering, only names it.
 */
function ConnectionLabel({
    connection,
    down
}: {
    connection: ConnectionSummary;
    down: string | null;
}) {
    return (
        <>
            {connection.kind === "personal" ? (
                <FolderHeart className="size-4 text-muted-foreground" />
            ) : (
                <HardDrive className="size-4 text-muted-foreground" />
            )}
            <span className="flex-1 truncate" title={connection.name}>
                {connection.name}
            </span>
            {connection.needsRekey ? (
                <Badge variant="warning" className="gap-1">
                    <AlertTriangle className="size-3" />
                    key changed
                </Badge>
            ) : null}
            {down ? (
                <Badge variant="danger" title={down}>
                    no answer
                </Badge>
            ) : null}
            {connection.shared ? <Badge variant="neutral">shared</Badge> : null}
            {connection.requiresHostd ? <Badge variant="neutral">host</Badge> : null}
        </>
    );
}

/**
 * Schedule-deletion dialog. Picks a future date/time and whether the deletion goes
 * to the recycle bin or is permanent, then registers a scheduled deletion per
 * target. The sweep (lazy on browse, or the cron) carries it out later.
 */
function ScheduleDeleteDialog({
    connectionId,
    targets,
    onOpenChange,
    onScheduled,
    onError
}: {
    connectionId: string;
    targets: DriveEntry[] | null;
    onOpenChange: (open: boolean) => void;
    onScheduled: () => void;
    onError: (message: string) => void;
}) {
    const [when, setWhen] = useState("");
    const [permanent, setPermanent] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (targets) {
            setWhen("");
            setPermanent(false);
            setError(null);
        }
    }, [targets]);

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (!targets || targets.length === 0) return;
        if (!when) {
            setError("Pick a date and time.");
            return;
        }
        setPending(true);
        setError(null);
        const iso = new Date(when).toISOString();
        let failure: string | null = null;
        for (const entry of targets) {
            const result = await driveActions.scheduleDeleteAction(
                connectionId,
                entry.path,
                iso,
                permanent
            );
            if (result.error) {
                failure = result.error;
                break;
            }
        }
        setPending(false);
        if (failure) {
            setError(failure);
            onError(failure);
            return;
        }
        onScheduled();
    }

    const count = targets?.length ?? 0;

    return (
        <Dialog open={targets !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Schedule deletion</DialogTitle>
                    <DialogDescription className="truncate">
                        {count === 1 ? targets?.[0]?.name : `${count} items`} will be deleted at the
                        time you choose.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Delete on
                        <Input
                            type="datetime-local"
                            value={when}
                            onChange={(event) => setWhen(event.target.value)}
                            required
                        />
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={permanent}
                            onChange={(event) => setPermanent(event.target.checked)}
                            className="size-4"
                        />
                        Delete permanently (skip the recycle bin)
                    </label>
                    <p className="text-xs text-muted-foreground">
                        Runs the next time this connection is browsed after that moment, or exactly
                        on time if the deletion cron is configured.
                    </p>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            type="submit"
                            variant={permanent ? "danger" : undefined}
                            disabled={pending}
                        >
                            {pending ? "Scheduling..." : "Schedule"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * The selected source is a server that is not answering. Browsing it would hang
 * on the SSH connect and end in a failure that says nothing useful, so the
 * reason is stated here instead and nothing is offered that needs the machine.
 */
function UnreachableServer({
    name,
    detail,
    onRecheck
}: {
    name: string;
    detail: string;
    onRecheck: () => void;
}) {
    return (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-6">
            <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">{name} is not answering</h3>
                    <p className="text-sm text-muted-foreground">
                        {detail}. Its files are unavailable until it is back.
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={onRecheck}>
                            <RefreshCw className="size-4" />
                            Check again
                        </Button>
                        <Button size="sm" variant="ghost" asChild>
                            <Link href="/apps/servers">Open Servers</Link>
                        </Button>
                    </div>
                </div>
            </div>
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
        driveActions.discoverUnasSharesAction(connectionId).then((result) => {
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
        const result = await driveActions.setUnasShareAction(connectionId, name);
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
                            Files are served from the device&apos;s SMB share, using the same UniFi
                            account you already entered. Pick the share to open.
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
                        No shares were detected automatically. Enter the share name below (enable
                        SMB on the UNAS if it is off).
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
                            className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
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
