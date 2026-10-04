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
import { ConflictDialog } from "./conflict-dialog";
import * as conflictActions from "./conflict-actions";
import type { UploadItem } from "@/lib/drop-items";
import { useConflictPrompt } from "./use-conflict-prompt";
import { MAX_CLASH_ENTRIES, type ClashView, type ConflictChoice } from "@/lib/drive/conflict-types";
import {
    chunked,
    conflictIn,
    planUploads,
    topLevelEntries,
    topOf,
    uploadConflictFor,
    type PlannedUpload,
    type UploadConflict
} from "./upload-plan";
import * as driveActions from "./actions";
import { SendDialog } from "./send-dialog";
import { useRouter } from "next/navigation";
import { TransfersPanel } from "./transfers-panel";
import type { DriveJobView } from "@/lib/drive-jobs";
import type { DriveAbilities } from "@/lib/drive-authz";
import * as serverActions from "../apps/servers/actions";
import { sendFile } from "@/components/transfers/move-file";
import { UnifiConsoleButton } from "./unifi-console-button";
import { ShareDialog, type ShareTarget } from "./share-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { driveJobFraction, driveJobSummary } from "@polaris/core";
import { RemoveConnectionDialog } from "./remove-connection-dialog";
import { RequestDialog, type RequestTarget } from "./request-dialog";
import { ConnectionDialog, EditConnectionDialog } from "./connection-dialog";
import { AccessDialog, UnlockPanel, type AccessTarget } from "./access-dialog";
import { PeopleShareDialog, type PeopleShareTarget } from "./people-share-dialog";
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
    isServerSource,
    mayBeUnreachable,
    type ConnectionSummary,
    type DriveEntry,
    type ListingFailure,
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
    Radar,
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
    notice,
    abilities
}: {
    connections: ConnectionSummary[];
    connectionId: string | null;
    path: string;
    /** Something the page worked out before this rendered and could not act on -
     *  shown in the same corner a failed operation is, and dismissed the same way. */
    notice?: string;
    /** What this reader may do in the folder that is open. Worked out by the page
     *  from the same gate the writes go through - see `driveAbilities`. */
    abilities: DriveAbilities;
}) {
    const router = useRouter();
    const t = useTranslations("drive");
    const fileInput = useRef<HTMLInputElement>(null);
    /** The listing request in flight. There is only ever one: a new location, or a
     *  refresh after a write, calls off the one before it instead of racing it. */
    const listing = useRef<AbortController | null>(null);
    const [pending, startTransition] = useTransition();
    const [uploading, setUploading] = useState(false);
    /** The "this name is already taken" question, as something an upload or a move can await. */
    const conflicts = useConflictPrompt();

    const [entries, setEntries] = useState<DriveEntry[]>([]);
    const [loading, setLoading] = useState(false);
    /** Why the listing did not arrive, as the panel draws it: the sentence, what
     *  to do about it, and - for somebody who administers this connection - what
     *  the device actually said. */
    const [error, setError] = useState<ListingFailure | null>(null);
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
    // What is being handed over, if anything. One item, because the dialog
    // names it and an offer of "seven things" is not something to answer.
    const [sending, setSending] = useState<{ path: string; name: string } | null>(null);
    const [requestTarget, setRequestTarget] = useState<RequestTarget | null>(null);
    const [ops, setOps] = useState<{ id: string; label: string }[]>([]);
    /**
     * The long work the server is doing for this account.
     *
     * Not the same thing as `ops`, which is a request this tab is waiting on.
     * These belong to the account rather than to the tab: they carry on when it
     * is closed, and a second tab watching the same Drive sees the same bar.
     */
    const [jobs, setJobs] = useState<DriveJobView[]>([]);
    /**
     * What is on its way out of the folder being looked at.
     *
     * A job takes minutes and everything it has not reached is still in the
     * listing, so a reload shows those files again - and pressing delete on them
     * a second time used to queue a second job that raced the first, lost, and
     * reported a failure nobody had caused. They are drawn as going and cannot be
     * chosen again; the server refuses them too, because another person's job is
     * just as real as this tab's.
     */
    const [going, setGoing] = useState<ReadonlySet<string>>(new Set());
    /**
     * Where the reader is, for the poll below to read.
     *
     * The poll is deliberately started once and never restarted - depending on
     * the folder would restart it on every step through a tree - so it cannot
     * close over the folder. A ref is the folder it can read on the tick it
     * actually runs.
     */
    const here = useRef({ connectionId, path });
    here.current = { connectionId, path };
    /** Recomputed on a timer so the estimate under a bar moves without waiting
     *  for the next poll. */
    const [tick, setTick] = useState(() => Date.now());
    const [opError, setOpError] = useState<string | null>(notice ?? null);

    // The page works the notice out on every render of its own, not only the
    // first: this component stays mounted while the reader moves between
    // locations, so seeding the state once would swallow every notice after it.
    useEffect(() => {
        if (notice) setOpError(notice);
    }, [notice]);

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
                    caught instanceof Error && caught.message
                        ? caught.message
                        : t("explorer.opFailed", { label })
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

    /**
     * Watch them while there are any.
     *
     * Every two seconds while something is running, and not at all when nothing
     * is: an explorer sitting open on a folder nobody is changing should not be
     * a request every two seconds for the rest of the afternoon. The first read
     * happens on mount, because a job started in another tab - or before this one
     * was reloaded - is exactly the case this exists to show.
     */
    useEffect(() => {
        let live = true;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const look = async () => {
            const result = await driveActions
                .driveJobsAction(here.current.connectionId ?? undefined, here.current.path)
                .catch(() => null);
            if (!live) return;
            const running = result?.jobs ?? [];
            setGoing(new Set(result?.going ?? []));
            setJobs((before) => {
                // A job that has just left the list finished, and the listing on
                // screen is the one it changed.
                if (before.length > 0 && running.length < before.length) {
                    dropDriveSnapshots();
                    void load();
                }
                return running;
            });
            setTick(Date.now());
            timer = setTimeout(() => void look(), running.length > 0 ? 2000 : 15_000);
        };

        void look();
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
        };
        // `load` is rebuilt on every render of this component; depending on it
        // would restart the poll on every keystroke in the search box.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
            return status?.state === "down" ? (status.detail ?? t("explorer.noAnswer")) : null;
        },
        [reachability, t]
    );
    /** Where Polaris dialled for the source being looked at. The reason on its own
     *  is not something anybody can act on: what has to be fixed depends on which
     *  address was tried. */
    const downEndpoint =
        (connectionId && reachability?.find((entry) => entry.id === connectionId)?.endpoint) ||
        null;
    const unreachable = downReason(connectionId);
    /** Whether the source being looked at is the machine Polaris runs on. It
     *  changes what the failure means and what is worth offering about it. */
    const downIsLocal = Boolean(
        connectionId && reachability?.find((entry) => entry.id === connectionId)?.local
    );
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
                // `no-store` as well as the header the route sends, because the
                // request is what decides whether the browser may answer from
                // its own cache before the server is asked at all.
                const res = await fetch(`/api/drive/list?${query.toString()}`, {
                    signal,
                    cache: "no-store"
                });
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
                    setError({
                        reason: body.error ?? t("explorer.readFailed"),
                        hint: typeof body.hint === "string" ? body.hint : null,
                        detail: typeof body.detail === "string" ? body.detail : null,
                        retryable: body.retryable !== false
                    });
                } else {
                    // Keep the current array (no re-render) when nothing actually
                    // changed - e.g. a background refresh after an optimistic rename
                    // or delete that already brought the list to this exact state.
                    const next = body.entries as DriveEntry[];
                    setEntries((prev) => (listingsEqual(prev, next) ? prev : next));
                    writeListing(connectionId, path, next);
                }
            } catch {
                // The request itself never landed - the tab went offline, or the
                // dashboard was restarting under it. Nothing was learned about
                // the device, so the offer is simply to ask again.
                if (!signal.aborted) {
                    setError({
                        reason: t("explorer.unreachable"),
                        hint: t("explorer.unreachableHint"),
                        detail: null,
                        retryable: true
                    });
                }
            } finally {
                if (!signal.aborted) setLoading(false);
            }
        },
        [connectionId, path, unreachable, t]
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

    /**
     * The clashes among `entries` in `folder`, asked in pieces the server takes.
     * Null when the check itself failed, which is said in the banner: nothing is
     * written into a folder that could not be checked.
     */
    async function clashesIn(
        folder: string,
        entries: { path: string; kind: "file" | "dir" }[],
        merge: boolean
    ): Promise<ClashView[] | null> {
        if (!connectionId) return null;
        const found: ClashView[] = [];
        for (const piece of chunked(entries, MAX_CLASH_ENTRIES)) {
            const answer = await conflictActions.nameClashesAction({
                connectionId,
                folder,
                entries: piece,
                merge
            });
            if (answer.error !== undefined) {
                setOpError(answer.error);
                return null;
            }
            found.push(...answer.clashes);
        }
        return found;
    }

    /**
     * Ask about every name an upload would take that is already taken - the items
     * landing in the folder, then the files inside any folder being merged - and
     * work out what to send. Null when the person cancelled or a check failed.
     */
    async function planUpload(items: UploadItem[]): Promise<PlannedUpload[] | null> {
        if (!connectionId) return null;
        const tops = topLevelEntries(items);
        const batch = items.length > 1;
        const decisions = new Map<string, ConflictChoice>();
        const clashes = await clashesIn(path, tops, true);
        if (!clashes) return null;
        if (clashes.length > 0) {
            const answers = await conflicts.ask({ clashes, batch });
            if (!answers) return null;
            for (const [key, choice] of answers) decisions.set(key, choice);
        }
        // "Merge": what is inside both folders is a question of its own.
        const merged = new Set(
            clashes
                .filter((clash) => clash.incomingKind === "dir" && decisions.get(clash.path) === "merge")
                .map((clash) => clash.path)
        );
        if (merged.size > 0) {
            const inner = items
                .filter(({ relPath }) => merged.has(topOf(relPath)))
                .map(({ relPath }) => ({ path: relPath, kind: "file" as const }));
            const innerClashes = await clashesIn(path, inner, true);
            if (!innerClashes) return null;
            if (innerClashes.length > 0) {
                const answers = await conflicts.ask({ clashes: innerClashes, batch });
                if (!answers) return null;
                for (const [key, choice] of answers) decisions.set(key, choice);
            }
        }
        // "Keep both" on a folder: the folder is made under its new name, so
        // every file of it goes there instead of into the one already here.
        const renamed = new Map<string, string>();
        for (const clash of clashes) {
            if (clash.incomingKind !== "dir" || decisions.get(clash.path) !== "keepBoth") continue;
            const made = await conflictActions.reserveFolderAction({
                connectionId,
                folder: path,
                name: clash.path
            });
            if (made.error !== undefined) {
                setOpError(made.error);
                return null;
            }
            renamed.set(clash.path, made.name);
        }
        return planUploads(items, decisions, renamed);
    }

    async function onUpload(items: UploadItem[]) {
        if (!connectionId || items.length === 0) return;
        setUploading(true);
        setOpError(null);
        try {
            const plan = await planUpload(items);
            if (!plan) return;
            // relPath may be nested (a/b/file.txt) for a folder upload; the route
            // creates the parent directories before writing.
            for (const step of plan) {
                if (!(await sendUpload(step, plan.length > 1))) return;
            }
        } finally {
            setUploading(false);
            if (fileInput.current) fileInput.current.value = "";
            void load();
        }
    }

    /**
     * Send one planned upload. A 409 is a name somebody took after the check -
     * the person is asked again and the file re-sent their way. False when they
     * cancelled, which stops the rest of the upload too.
     */
    async function sendUpload(step: PlannedUpload, batch: boolean): Promise<boolean> {
        if (!connectionId) return false;
        let conflict = step.conflict;
        // Bounded: each round is a person answering a dialog, and three clashes
        // in a row on one file means something else is writing there.
        for (let round = 0; round < 3; round++) {
            const query = new URLSearchParams({ c: connectionId, name: step.relPath, conflict });
            if (path) query.set("p", path);
            // Through the shared sender, so the file gets a bar in the corner and
            // can be stopped - a folder of holiday video through `fetch` was a
            // spinner that knew nothing for twenty minutes.
            const sent = await sendFile(`/api/drive/upload?${query.toString()}`, step.file, {
                name: step.relPath
            });
            if (sent.ok || sent.problem === "stopped") return true;
            const clash = sent.status === 409 ? conflictIn(sent.body) : null;
            if (clash) {
                const answers = await conflicts.ask({ clashes: [clash], batch, late: true });
                if (!answers) return false;
                const choice = answers.get(clash.path);
                if (choice === "skip") return true;
                conflict = uploadConflictFor(choice);
                continue;
            }
            // No answer to read a reason from: the connection dropped, or every
            // byte went and the server never said what became of them. Said here
            // too, not only in the corner, because this is where the folder is.
            if (sent.problem === "noAnswer")
                setOpError(t("explorer.uploadNoAnswer", { name: step.relPath }));
            else if (sent.problem === "dropped")
                setOpError(t("explorer.uploadDropped", { name: step.relPath }));
            else setOpError(sent.body || t("explorer.refused"));
            return true;
        }
        return true;
    }

    function submitNewFolder(event: React.FormEvent) {
        event.preventDefault();
        const name = newFolderName.trim();
        if (!connectionId || !name) return;
        setNewFolderOpen(false);
        setNewFolderName("");
        runOp(t("explorer.ops.creating", { name }), () =>
            driveActions.mkdirAction(connectionId, path, name)
        );
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
        runOp(t("explorer.ops.creating", { name }), () =>
            driveActions.createFileAction(connectionId, path, name)
        );
    }

    function onSetNote(entry: DriveEntry, note: string | null) {
        if (!connectionId) return;
        setEntries((prev) => prev.map((row) => (row.path === entry.path ? { ...row, note } : row)));
        startTransition(async () => {
            await driveActions.setItemNoteAction(connectionId, entry.path, note);
            void load();
        });
    }

    function onMove(list: DriveEntry[], destFolderPath: string) {
        void transferInto("move", list, destFolderPath);
    }

    function onCopy(list: DriveEntry[], destFolderPath: string) {
        void transferInto("copy", list, destFolderPath);
    }

    /**
     * Move or copy items into a folder, asking first about any name already
     * taken there. A copy into the folder it is already in is a duplicate and
     * gets its " copy" suffix without a question; a move there is nothing to do.
     */
    async function transferInto(kind: "move" | "copy", list: DriveEntry[], dest: string) {
        if (!connectionId) return;
        const intoSelf = (entry: DriveEntry) =>
            dest === entry.path || dest.startsWith(`${entry.path}/`);
        const duplicates = kind === "copy" ? list.filter((entry) => parentOf(entry.path) === dest) : [];
        for (const entry of duplicates) {
            runOp(t("explorer.ops.copying", { name: entry.name }), () =>
                driveActions.copyAction(connectionId, entry.path, dest)
            );
        }
        const arriving = list.filter((entry) => parentOf(entry.path) !== dest && !intoSelf(entry));
        if (arriving.length === 0) return;
        const clashes = await clashesIn(
            dest,
            arriving.map((entry) => ({
                path: entry.name,
                kind: entry.kind === "dir" ? "dir" : "file"
            })),
            false
        );
        if (!clashes) return;
        let decisions = new Map<string, ConflictChoice>();
        if (clashes.length > 0) {
            const answers = await conflicts.ask({ clashes, batch: arriving.length > 1 });
            if (!answers) return;
            decisions = answers;
        }
        for (const entry of arriving) {
            const choice = decisions.get(entry.name);
            if (choice === "skip") continue;
            if (kind === "move") setEntries((prev) => prev.filter((row) => row.path !== entry.path));
            runOp(
                t(kind === "move" ? "explorer.ops.moving" : "explorer.ops.copying", {
                    name: entry.name
                }),
                () => transferOne(kind, entry, dest, uploadConflictFor(choice), arriving.length > 1)
            );
        }
    }

    /** One move or copy, asking again if the name was taken after the check. */
    async function transferOne(
        kind: "move" | "copy",
        entry: DriveEntry,
        dest: string,
        first: UploadConflict,
        batch: boolean
    ): Promise<{ error?: string }> {
        if (!connectionId) return {};
        let mode = first;
        for (let round = 0; round < 3; round++) {
            const result =
                kind === "move"
                    ? await driveActions.moveIntoAction(connectionId, entry.path, dest, mode)
                    : await driveActions.copyAction(connectionId, entry.path, dest, mode);
            if (!result.conflict) return result;
            const answers = await conflicts.ask({ clashes: [result.conflict], batch, late: true });
            const choice = answers?.get(result.conflict.path);
            if (!answers || choice === "skip") return {};
            mode = uploadConflictFor(choice);
        }
        return {};
    }

    function confirmDelete() {
        if (!connectionId || !deleteTargets) return;
        const targets = deleteTargets;
        setDeleteTargets(null);
        const paths = new Set(targets.map((entry) => entry.path));
        setEntries((prev) => prev.filter((entry) => !paths.has(entry.path)));
        // One job rather than one request per file. See `lib/drive-jobs`: the
        // loop this replaces opened a connection to the storage per item, could
        // not be navigated away from, and died with the tab.
        void startJob("trash", targets);
    }

    function confirmDeletePermanent() {
        if (!connectionId || !permanentTargets) return;
        const targets = permanentTargets;
        setPermanentTargets(null);
        const paths = new Set(targets.map((entry) => entry.path));
        setEntries((prev) => prev.filter((entry) => !paths.has(entry.path)));
        void startJob("delete", targets);
    }

    /**
     * Hand a selection to the server and let it get on with it.
     *
     * The rows leave the listing at once - the answer is not in doubt, and a list
     * that waits for seven thousand files to move is a list nobody can use - and
     * the panel shows the bar. A refusal puts them back on the next read.
     */
    async function startJob(kind: "trash" | "delete", targets: DriveEntry[]) {
        if (!connectionId) return;
        setOpError(null);
        const result = await driveActions.startDriveJobAction(
            connectionId,
            kind,
            targets.map((entry) => entry.path)
        );
        if (result.error) {
            setOpError(result.error);
            dropDriveSnapshots();
            void load();
            return;
        }
        if (result.job) setJobs((before) => [...before, result.job as DriveJobView]);
    }

    function confirmEmpty() {
        if (!connectionId || !emptyTarget) return;
        const { entry, permanent } = emptyTarget;
        setEmptyTarget(null);
        const label = permanent
            ? t("explorer.ops.emptying", { name: entry.name })
            : t("explorer.ops.emptyingToTrash", { name: entry.name });
        runOp(label, () => driveActions.emptyFolderAction(connectionId, entry.path, permanent));
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
            <aside className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium text-muted-foreground">
                        {t("explorer.locations")}
                    </h2>
                    <div className="flex items-center gap-1">
                        {anyDown ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={recheckSources}
                                disabled={rechecking}
                                title={t("explorer.checkAgain")}
                                aria-label={t("explorer.checkSources")}
                            >
                                <RefreshCw className={cn("size-4", rechecking && "animate-spin")} />
                            </Button>
                        ) : null}
                        <ConnectionDialog />
                    </div>
                </div>
                <nav className="flex flex-col gap-1">
                    {connections.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t("explorer.noConnections")}
                        </p>
                    ) : (
                        connections.map((connection) => (
                            <div key={connection.id} className="group flex items-center gap-1">
                                {downReason(connection.id) ? (
                                    // Off, so there is nothing to open: browsing it
                                    // would only spend its connect timeout to say so.
                                    <span
                                        aria-disabled="true"
                                        title={t("explorer.notAnswering", {
                                            reason: downReason(connection.id) ?? ""
                                        })}
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
                                            prefetchListing(
                                                connection.id,
                                                connection.rootPath ?? ""
                                            )
                                        }
                                        onFocus={() =>
                                            prefetchListing(
                                                connection.id,
                                                connection.rootPath ?? ""
                                            )
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
                                        className="rounded-md p-1 text-warning transition-colors hover:bg-warning-soft"
                                        aria-label={t("explorer.updateCredentialsFor", {
                                            name: connection.name
                                        })}
                                        title={t("explorer.updateCredentials")}
                                    >
                                        <KeyRound className="size-4" />
                                    </button>
                                ) : null}
                                {connection.editable ? (
                                    <button
                                        type="button"
                                        onClick={() => setEditConn(connection)}
                                        className="rounded-md p-1 text-muted-foreground transition-opacity hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                                        aria-label={t("explorer.editNamed", {
                                            name: connection.name
                                        })}
                                    >
                                        <Pencil className="size-4" />
                                    </button>
                                ) : null}
                                {connection.editable ? (
                                    <button
                                        type="button"
                                        onClick={() => setDeleteConn(connection)}
                                        className="rounded-md p-1 text-muted-foreground transition-opacity hover:text-danger md:opacity-0 md:group-hover:opacity-100"
                                        aria-label={t("explorer.removeNamed", {
                                            name: connection.name
                                        })}
                                    >
                                        <Trash2 className="size-4" />
                                    </button>
                                ) : null}
                            </div>
                        ))
                    )}
                </nav>
            </aside>

            <section className="min-w-0 space-y-4">
                {/* Above the files, because an offer waiting to be answered is
                    the one thing on this screen that somebody else is waiting on.
                    It draws nothing at all when there is nothing waiting. */}
                <TransfersPanel />
                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        {t("explorer.addConnection")}
                    </div>
                ) : unreachable ? (
                    <UnreachableServer
                        name={selectedConnection?.name ?? t("explorer.thisServer")}
                        detail={unreachable}
                        endpoint={downEndpoint}
                        // Straight to the machine's own page rather than to the
                        // list: that page is where the button that looks for it
                        // lives, and a server that is not answering is exactly
                        // when somebody needs it.
                        serverHref={
                            isServerSource(connectionId)
                                ? `/apps/servers/${connectionId.slice("host:".length)}`
                                : null
                        }
                        // No id when it is this machine: the search skips
                        // Polaris' own address by design, so it could only ever
                        // come back with "not on this network" about the box it
                        // is running on.
                        hostId={
                            isServerSource(connectionId) && !downIsLocal
                                ? connectionId.slice("host:".length)
                                : null
                        }
                        local={downIsLocal}
                        onRecheck={recheckSources}
                    />
                ) : selectedConnection?.needsRekey ? (
                    <div className="rounded-md border border-warning-edge bg-warning-soft p-6">
                        <div className="flex items-start gap-3">
                            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
                            <div className="flex flex-col gap-2">
                                <h3 className="text-sm font-medium">{t("explorer.rekeyTitle")}</h3>
                                <p className="text-sm text-muted-foreground">
                                    {t("explorer.rekeyBody")}
                                </p>
                                {selectedConnection.canManageAccess ? (
                                    <div>
                                        <Button
                                            size="sm"
                                            onClick={() => setEditConn(selectedConnection)}
                                            className="mt-1"
                                        >
                                            <KeyRound className="size-4" />
                                            {t("explorer.updateCredentials")}
                                        </Button>
                                    </div>
                                ) : (
                                    <p className="text-xs text-muted-foreground">
                                        {t("explorer.askOwner")}
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
                        abilities={abilities}
                        going={going}
                        connectionId={connectionId}
                        path={path}
                        segments={segments}
                        rootPath={selectedConnection?.rootPath ?? ""}
                        entries={entries}
                        loading={loading}
                        error={error}
                        onRetry={() => void load(true)}
                        pending={pending}
                        uploading={uploading}
                        fileInput={fileInput}
                        href={href}
                        onNewFolder={() => setNewFolderOpen(true)}
                        onNewFile={() => setNewFileOpen(true)}
                        onUpload={onUpload}
                        onDelete={
                            // A container and a registered server have no recycle
                            // bin to move anything into - see `moveManyToTrash`.
                            isSavedConnection(connectionId)
                                ? (items) => setDeleteTargets(items)
                                : undefined
                        }
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
                                                  t("explorer.thisFolder"),
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
                        onSend={
                            isSavedConnection(connectionId)
                                ? (entry) => setSending({ path: entry.path, name: entry.name })
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
                                              t("explorer.thisFolder"),
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
                                                        t("explorer.thisFolder")
                                                })
                                            }
                                            title={t("explorer.access")}
                                            aria-label={t("explorer.access")}
                                        >
                                            <ShieldCheck className="size-4" />
                                            <span className="hidden sm:inline">
                                                {t("explorer.access")}
                                            </span>
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

            {ops.length > 0 || jobs.length > 0 ? (
                <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-3 rounded-lg border border-border-strong bg-elevated p-3 shadow-popover">
                    <p className="text-xs font-medium text-muted-foreground">
                        {t("explorer.background")}
                    </p>
                    {ops.map((op) => (
                        <div key={op.id} className="flex items-center gap-2 text-sm">
                            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                            <span className="min-w-0 flex-1 truncate" title={op.label}>
                                {op.label}
                            </span>
                        </div>
                    ))}
                    {jobs.map((job) => (
                        <div key={job.id} className="flex flex-col gap-1">
                            <div className="flex items-center gap-2 text-sm">
                                <span className="min-w-0 flex-1 truncate" title={job.label}>
                                    {job.label}
                                </span>
                                <button
                                    type="button"
                                    aria-label={t("explorer.stopNamed", { label: job.label })}
                                    title={t("explorer.stopHint")}
                                    onClick={() => {
                                        setJobs((before) =>
                                            before.filter((entry) => entry.id !== job.id)
                                        );
                                        void driveActions.cancelDriveJobAction(job.id);
                                    }}
                                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                >
                                    <X className="size-3.5" />
                                </button>
                            </div>
                            {/* A bar with a number beside it. A spinner on its own
                                is indistinguishable from a hang, which is why
                                people press the button a second time. */}
                            <div
                                role="progressbar"
                                aria-label={job.label}
                                aria-valuemin={0}
                                aria-valuemax={job.total}
                                aria-valuenow={job.done}
                                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                            >
                                <div
                                    className="h-full rounded-full bg-primary transition-[width] duration-500"
                                    style={{
                                        width: `${Math.round(driveJobFraction(job) * 100)}%`
                                    }}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {driveJobSummary({ ...job, startedAt: job.startedAt }, tick)}
                            </p>
                            {job.error ? <p className="text-xs text-danger">{job.error}</p> : null}
                        </div>
                    ))}
                </div>
            ) : null}

            {opError ? (
                <div className="fixed bottom-4 right-4 z-50 flex w-80 items-start gap-2 rounded-lg border border-danger-edge bg-danger-soft p-3 text-sm text-danger-ink shadow-popover">
                    <Info className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{opError}</span>
                    <button
                        type="button"
                        onClick={() => setOpError(null)}
                        className="shrink-0 rounded p-0.5 hover:bg-danger-soft"
                        aria-label={t("explorer.dismiss")}
                    >
                        <X className="size-4" />
                    </button>
                </div>
            ) : null}

            <ConflictDialog request={conflicts.request} onDone={conflicts.respond} />
            <ShareDialog
                targets={shareTargets}
                onOpenChange={(open) => !open && setShareTargets(null)}
            />
            <PeopleShareDialog
                target={peopleTarget}
                onOpenChange={(open) => !open && setPeopleTarget(null)}
                onChanged={() => void load()}
            />
            {sending && connectionId ? (
                <SendDialog
                    open
                    onOpenChange={(open) => !open && setSending(null)}
                    connectionId={connectionId}
                    path={sending.path}
                    name={sending.name}
                    onSent={() => setSending(null)}
                />
            ) : null}
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
                        <DialogTitle>{t("explorer.newFolder.title")}</DialogTitle>
                        <DialogDescription>{t("explorer.newFolder.description")}</DialogDescription>
                    </DialogHeader>
                    <form onSubmit={submitNewFolder} className="flex flex-col gap-3">
                        <Input
                            autoFocus
                            value={newFolderName}
                            onChange={(event) => setNewFolderName(event.target.value)}
                            placeholder={t("explorer.newFolder.placeholder")}
                        />
                        <div className="flex justify-end gap-2">
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    {t("explorer.cancel")}
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={!newFolderName.trim()}>
                                {t("explorer.create")}
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("explorer.newFile.title")}</DialogTitle>
                        <DialogDescription>{t("explorer.newFile.description")}</DialogDescription>
                    </DialogHeader>
                    <form onSubmit={submitNewFile} className="flex flex-col gap-3">
                        <Input
                            autoFocus
                            value={newFileName}
                            onChange={(event) => setNewFileName(event.target.value)}
                            // i18n-ignore: an example file name
                            placeholder="Untitled.txt"
                        />
                        <div className="flex justify-end gap-2">
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    {t("explorer.cancel")}
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={!newFileName.trim()}>
                                {t("explorer.create")}
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
                            {deleteTargets && deleteTargets.length > 1
                                ? t("explorer.trash.titleMany", { count: deleteTargets.length })
                                : t("explorer.trash.titleOne")}
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {deleteTargets && deleteTargets.length === 1
                                ? t("explorer.trash.bodyOne", {
                                      name: deleteTargets[0]?.name ?? ""
                                  })
                                : t("explorer.trash.bodyMany")}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setDeleteTargets(null)}
                        >
                            {t("explorer.cancel")}
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmDelete}>
                            {t("explorer.trash.confirm")}
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
                                ? t("explorer.empty.titlePermanent")
                                : t("explorer.empty.titleTrash")}
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {emptyTarget
                                ? emptyTarget.permanent
                                    ? t("explorer.empty.bodyPermanent", {
                                          name: emptyTarget.entry.name
                                      })
                                    : t("explorer.empty.bodyTrash", {
                                          name: emptyTarget.entry.name
                                      })
                                : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => setEmptyTarget(null)}>
                            {t("explorer.cancel")}
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmEmpty}>
                            {emptyTarget?.permanent
                                ? t("explorer.empty.confirmPermanent")
                                : t("explorer.empty.confirmTrash")}
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
                            {permanentTargets && permanentTargets.length > 1
                                ? t("explorer.delete.titleMany", { count: permanentTargets.length })
                                : t("explorer.delete.titleOne")}
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {permanentTargets && permanentTargets.length === 1
                                ? t("explorer.delete.bodyOne", {
                                      name: permanentTargets[0]?.name ?? ""
                                  })
                                : t("explorer.delete.bodyMany")}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setPermanentTargets(null)}
                        >
                            {t("explorer.cancel")}
                        </Button>
                        <Button type="button" variant="danger" onClick={confirmDeletePermanent}>
                            {t("explorer.delete.confirm")}
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
    const t = useTranslations("drive");
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
                    {t("explorer.badges.keyChanged")}
                </Badge>
            ) : null}
            {down ? (
                <Badge variant="danger" title={down}>
                    {t("explorer.badges.noAnswer")}
                </Badge>
            ) : null}
            {connection.shared ? (
                <Badge variant="neutral">{t("explorer.badges.shared")}</Badge>
            ) : null}
            {connection.requiresHostd ? (
                <Badge variant="neutral">{t("explorer.badges.host")}</Badge>
            ) : null}
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
    const t = useTranslations("drive");
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
            setError(t("explorer.schedule.pickTime"));
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
                    <DialogTitle>{t("explorer.schedule.title")}</DialogTitle>
                    <DialogDescription className="truncate">
                        {count === 1
                            ? t("explorer.schedule.bodyOne", { name: targets?.[0]?.name ?? "" })
                            : t("explorer.schedule.bodyMany", { count })}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("explorer.schedule.deleteOn")}
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
                        {t("explorer.schedule.permanent")}
                    </label>
                    <p className="text-xs text-muted-foreground">{t("explorer.schedule.hint")}</p>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                {t("explorer.cancel")}
                            </Button>
                        </DialogClose>
                        <Button
                            type="submit"
                            variant={permanent ? "danger" : undefined}
                            disabled={pending}
                        >
                            {pending
                                ? t("explorer.schedule.scheduling")
                                : t("explorer.schedule.submit")}
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
    endpoint,
    serverHref,
    hostId,
    local,
    onRecheck
}: {
    name: string;
    detail: string;
    /** Where Polaris dialled, as `host:port`. Null for a source whose address
     *  could not be worked out at all. */
    endpoint: string | null;
    /** This machine's own page, when the source is a registered server. Null for
     *  a NAS or anything else without one. */
    serverHref: string | null;
    /** The server's id, when the source is one. What the search needs. */
    hostId: string | null;
    /** Whether this is the machine Polaris runs on. */
    local: boolean;
    onRecheck: () => void;
}) {
    /**
     * Look for the machine on this network, and move Polaris to it if it is
     * found.
     *
     * Started here rather than waited for. A server whose DHCP lease moved is
     * the commonest reason this panel is on screen, the search needs nothing
     * from anybody, and telling somebody to open another screen and press a
     * button there is telling them to do what Polaris could have done - which is
     * the one thing this product is not allowed to do. The manual button stays
     * for a second go.
     *
     * Every candidate is checked against the host key this server is already
     * pinned to, so nothing is believed on the strength of having answered.
     */
    const t = useTranslations("drive");
    const [search, setSearch] = useState<
        | { kind: "idle" }
        | { kind: "looking" }
        | { kind: "found"; address: string }
        | { kind: "elsewhere" }
        | { kind: "nowhere-to-look" }
        | { kind: "failed" }
    >({ kind: "idle" });

    const look = useCallback(async () => {
        if (!hostId) return;
        setSearch({ kind: "looking" });
        const result = await serverActions.recoverServerAddressAction(hostId);
        if (result.found) {
            setSearch({ kind: "found", address: result.found });
            onRecheck();
            return;
        }
        if (result.error) {
            setSearch({ kind: "failed" });
            return;
        }
        // Polaris not knowing its own address is a different answer from the
        // machine not being there, and saying the second when the first is true
        // sends somebody looking at the wrong thing.
        setSearch({
            kind: result.path?.kind === "unknown" ? "nowhere-to-look" : "elsewhere"
        });
    }, [hostId, onRecheck]);

    // Once per machine. A second attempt is the button, so a network that is
    // genuinely down does not get swept every time this panel re-renders.
    const started = useRef<string | null>(null);
    useEffect(() => {
        if (!hostId || started.current === hostId) return;
        started.current = hostId;
        void look();
    }, [hostId, look]);

    return (
        <div className="rounded-md border border-danger-edge bg-danger-soft p-6">
            <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
                <div className="flex flex-col gap-2">
                    {/* The machine Polaris runs on cannot be "not answering":
                        it is holding up the page the sentence would be printed
                        on. What has failed is Polaris reaching its own host from
                        inside its container, which is a different fault with a
                        different answer, and saying the first sends somebody to
                        check a machine that is plainly fine. */}
                    <h3 className="text-sm font-medium">
                        {local
                            ? t("explorer.down.localTitle", { name })
                            : t("explorer.down.title", { name })}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                        {local
                            ? t("explorer.down.localBody", { name })
                            : t("explorer.down.body", { detail })}
                    </p>
                    {/* The address it dialled, which is what turns a reason into
                        something somebody can act on: "that address does not
                        resolve" is a different afternoon depending on whether it
                        is a public name, a machine name only the office knows, or
                        an IP that has since moved. */}
                    {endpoint ? (
                        <p className="text-xs text-muted-foreground">
                            {t.rich("explorer.down.tried", {
                                endpoint,
                                mono: (chunks) => (
                                    <span key="endpoint" className="font-mono">
                                        {chunks}
                                    </span>
                                )
                            })}
                        </p>
                    ) : null}
                    {/* What Polaris is doing about it, without being asked. */}
                    {search.kind === "looking" ? (
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="size-3 animate-spin" />
                            {t("explorer.down.looking")}
                        </p>
                    ) : search.kind === "found" ? (
                        <p className="text-xs text-success">
                            {t.rich("explorer.down.found", {
                                address: search.address,
                                mono: (chunks) => (
                                    <span key="address" className="font-mono">
                                        {chunks}
                                    </span>
                                )
                            })}
                        </p>
                    ) : search.kind === "elsewhere" ? (
                        <p className="text-xs text-muted-foreground">
                            {t("explorer.down.elsewhere")}
                        </p>
                    ) : search.kind === "nowhere-to-look" ? (
                        <p className="text-xs text-muted-foreground">
                            {t("explorer.down.nowhere")}
                        </p>
                    ) : search.kind === "failed" ? (
                        <p className="text-xs text-muted-foreground">
                            {t("explorer.down.searchFailed")}
                        </p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={onRecheck}>
                            <RefreshCw className="size-4" />
                            {t("explorer.checkAgain")}
                        </Button>
                        {hostId ? (
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={search.kind === "looking"}
                                onClick={() => void look()}
                            >
                                <Radar className="size-4" />
                                {t("explorer.down.look")}
                            </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" asChild>
                            <Link href={serverHref ?? "/apps/servers"}>
                                {serverHref
                                    ? t("explorer.down.open", { name })
                                    : t("explorer.down.openServers")}
                            </Link>
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
    const t = useTranslations("drive");
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
                        <span className="font-medium">{t("explorer.smb.title")}</span>
                        <span className="text-muted-foreground">{t("explorer.smb.body")}</span>
                    </div>
                </div>

                {discovering ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Skeleton className="h-8 w-24" />
                        <Skeleton className="h-8 w-24" />
                        <span>{t("explorer.smb.detecting")}</span>
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
                    <p className="text-sm text-muted-foreground">{t("explorer.smb.none")}</p>
                )}

                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void choose(share);
                    }}
                    className="flex flex-wrap items-end gap-2"
                >
                    <label className="flex flex-1 flex-col gap-1 text-sm">
                        {t("explorer.smb.type")}
                        <input
                            className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
                            value={share}
                            onChange={(event) => setShare(event.target.value)}
                            placeholder={t("explorer.smb.placeholder")}
                        />
                    </label>
                    <Button type="submit" variant="ghost" disabled={pending || !share.trim()}>
                        {pending ? t("explorer.smb.connecting") : t("explorer.smb.connect")}
                    </Button>
                </form>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
