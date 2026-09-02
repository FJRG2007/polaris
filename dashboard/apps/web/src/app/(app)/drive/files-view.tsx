"use client";

/**
 * The file table for one location: breadcrumb, a search/sort/filter toolbar, and
 * a selectable list. Rows support fuzzy search (fuse.js), category/size/date
 * filters, multi-select (ctrl toggles, shift extends a range), inline rename
 * (double-click the name text), a right-click context menu, and bulk
 * download/delete. Opening a file swaps the listing for its preview in place -
 * the details panel pinned to the right keeps describing it - rather than
 * covering the explorer with a modal. All of this is client-side over the
 * already-fetched listing, so it stays fast and does not re-hit the NAS on
 * every keystroke.
 */

import Fuse from "fuse.js";
import Link from "next/link";
import type { DriveEntry } from "./types";
import { FolderTree } from "./folder-tree";
import { fileIconFor } from "./file-icons";
import { EntryThumbnail } from "./entry-thumbnail";
import { thumbnailKind } from "@/lib/drive-thumbnail-kind";
import { useRouter } from "next/navigation";
import { formatBytes } from "@polaris/core";
import { keyboardIsBusy } from "@/lib/keyboard";
import { ArchiveDialog } from "./archive-dialog";
import { useDriveInsights } from "./use-drive-insights";
import { SelectionZipMenu } from "./selection-zip-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RelativeTime } from "@/components/relative-time";
import { matchShortcut, SHORTCUT_HINTS } from "./shortcuts";
import { activityKey, prefetchListing } from "./listing-cache";
import { useDisplayFormat } from "@/components/display-format";
import { matchesStructured, parseSearch } from "./search-query";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { UserProfileDialog } from "@/components/user-profile-dialog";
import { FilePreview, isViewable, type ViewerTarget } from "./file-viewer";
import { filesToItems, gatherDropItems, type UploadItem } from "@/lib/drop-items";
import { ITEM_ICONS, ITEM_ICON_COLORS, iconColorClass, iconComponent } from "./item-icons";
import {
    FILE_CATEGORIES,
    categoryOfExtension,
    extensionOf,
    type FileCategory
} from "./file-categories";
import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type MouseEvent,
    type ReactNode
} from "react";
import {
    cn,
    Badge,
    Input,
    Button,
    Dialog,
    Checkbox,
    Skeleton,
    Textarea,
    ContextMenu,
    DialogTitle,
    DialogHeader,
    DropdownMenu,
    DialogContent,
    ContextMenuSub,
    ContextMenuItem,
    ContextMenuLabel,
    DropdownMenuItem,
    DialogDescription,
    keepFocusOnClose,
    useDeferredFocus,
    ContextMenuContent,
    ContextMenuTrigger,
    DropdownMenuContent,
    DropdownMenuTrigger,
    ContextMenuSeparator,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    MenuShortcut
} from "@polaris/ui";
import {
    ArrowDown,
    ArrowUp,
    ArrowUpDown,
    CalendarClock,
    ChevronLeft,
    ChevronRight,
    ClipboardCopy,
    ClipboardPaste,
    Copy,
    Download,
    Eraser,
    Eye,
    EyeOff,
    FileArchive,
    FilePlus,
    Files,
    Folder,
    FolderInput,
    FolderPlus,
    FolderTree as FolderTreeIcon,
    FolderUp,
    Inbox,
    Info,
    KeyRound,
    LayoutGrid,
    Link2,
    List,
    Lock,
    Palette,
    Pencil,
    Scissors,
    Search,
    Share2,
    ShieldCheck,
    SlidersHorizontal,
    Star,
    StickyNote,
    Trash2,
    Upload,
    Users,
    X,
    type LucideIcon
} from "lucide-react";

/** How many folders deep a path is; 0 for the root. Used to hide the crumbs
 *  above a folder that was shared, which lead somewhere the viewer is refused. */
function depthOf(path: string): number {
    return path === "" ? 0 : path.split("/").length;
}

const SORT_KEYS = ["name", "created", "modified", "size"] as const;
type SortKey = (typeof SORT_KEYS)[number];
type SortDir = "asc" | "desc";

/** What each column is called, in the heading and in the grid's menu, so the two
 *  cannot come to call the same thing different things. */
const SORT_LABELS: Record<SortKey, string> = {
    name: "Name",
    created: "Created on",
    modified: "Last Modified",
    size: "Size"
};

/**
 * A column heading that sorts by itself.
 *
 * The arrow is drawn on the column being sorted by and appears under the pointer
 * on the others, which is the idiom every file list uses: it says which column
 * decides the order without printing an arrow four times, and it still says the
 * other three are pressable to anybody who goes looking.
 *
 * Pressing the column already being sorted by turns the order round. That is the
 * whole of "choosing the direction here" - a second control for it would be a
 * second thing to hit on a heading that is 24 pixels tall.
 */
function SortHeading({
    column,
    sortKey,
    sortDir,
    onChoose,
    className
}: {
    column: SortKey;
    sortKey: SortKey;
    sortDir: SortDir;
    onChoose: (column: SortKey) => void;
    className?: string;
}) {
    const active = sortKey === column;
    return (
        <div className={cn("flex items-center", className)}>
            <button
                type="button"
                onClick={() => onChoose(column)}
                aria-label={
                    active
                        ? `Sorted by ${SORT_LABELS[column].toLowerCase()}, ${sortDir === "asc" ? "ascending" : "descending"}. Reverse it.`
                        : `Sort by ${SORT_LABELS[column].toLowerCase()}`
                }
                className={cn(
                    "group/sort flex min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground",
                    active && "text-foreground"
                )}
            >
                <span className="truncate">{SORT_LABELS[column]}</span>
                {active ? (
                    sortDir === "asc" ? (
                        <ArrowUp className="size-3 shrink-0" />
                    ) : (
                        <ArrowDown className="size-3 shrink-0" />
                    )
                ) : (
                    // Held in the layout rather than appearing on hover, so a
                    // heading does not change width the moment a pointer crosses
                    // it and shove the three beside it sideways.
                    <ArrowUpDown className="size-3 shrink-0 opacity-0 transition-opacity group-hover/sort:opacity-60" />
                )}
            </button>
        </div>
    );
}

interface ActivityItem {
    id: string;
    action: string;
    actorId: string | null;
    actor: string | null;
    at: string;
}

/** How old a remembered activity feed may be and still be shown while it refreshes. */
const ACTIVITY_CACHE_TTL_MS = 30_000;

/** Human label for an audit action shown in the activity feed. */
const ACTIVITY_LABELS: Record<string, string> = {
    "drive.download": "Downloaded",
    "drive.upload": "Uploaded",
    "drive.create": "Created",
    "drive.mkdir": "Created",
    "drive.move": "Moved or renamed",
    "drive.copy": "Copied",
    "drive.trash": "Moved to Trash",
    "drive.delete": "Deleted"
};

function activityLabel(action: string): string {
    return ACTIVITY_LABELS[action] ?? action.replace(/^drive\./, "");
}

/** Icon for an audit action shown beside its activity label. */
const ACTIVITY_ICONS: Record<string, LucideIcon> = {
    "drive.download": Download,
    "drive.upload": Upload,
    "drive.create": FilePlus,
    "drive.mkdir": FolderPlus,
    "drive.move": FolderInput,
    "drive.copy": Copy,
    "drive.trash": Trash2,
    "drive.delete": Trash2
};

function activityIcon(action: string): LucideIcon {
    return ACTIVITY_ICONS[action] ?? Info;
}

function downloadUrl(connectionId: string, path: string): string {
    return `/api/drive/download?c=${connectionId}&p=${encodeURIComponent(path)}`;
}

/** Trigger a browser download for a file entry without leaving the page. */
function triggerDownload(connectionId: string, entry: DriveEntry) {
    const anchor = document.createElement("a");
    anchor.href = downloadUrl(connectionId, entry.path);
    anchor.download = entry.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

/** URL of the ZIP endpoint bundling several paths (files and/or folders). */
function zipUrl(connectionId: string, paths: string[]): string {
    const params = new URLSearchParams({ c: connectionId });
    for (const path of paths) params.append("p", path);
    return `/api/drive/download-zip?${params.toString()}`;
}

/**
 * Download a selection. A single file streams directly; anything else (multiple
 * items, or a folder) is bundled server-side into one ZIP - a single navigation,
 * so the browser never blocks it the way it blocks a burst of anchor clicks.
 */
function downloadSelection(connectionId: string, entries: DriveEntry[]) {
    if (entries.length === 0) return;
    if (entries.length === 1 && entries[0] && entries[0].kind !== "dir") {
        triggerDownload(connectionId, entries[0]);
        return;
    }
    const anchor = document.createElement("a");
    anchor.href = zipUrl(
        connectionId,
        entries.map((entry) => entry.path)
    );
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

export function FilesView({
    connectionId,
    path,
    segments,
    rootPath = "",
    entries,
    loading,
    error,
    pending,
    uploading,
    fileInput,
    href,
    onNewFolder,
    onNewFile,
    onUpload,
    onDelete,
    onRename,
    onShare,
    onShareFolder,
    onSharePeople,
    onSharePeopleFolder,
    onRequestFiles,
    onToggleHidden,
    onSetFavorite,
    onSetIcon,
    onSetNote,
    onMove,
    onCopy,
    onManageAccess,
    onDeletePermanent,
    onEmptyFolder,
    onScheduleDelete,
    onSaved,
    headerActions
}: {
    connectionId: string;
    path: string;
    segments: string[];
    /** The shallowest folder the viewer may open here. Empty for a location of
     *  their own; a folder somebody shared with them opens at that folder and
     *  everything above it is theirs to see the name of, not to walk into. */
    rootPath?: string;
    entries: DriveEntry[];
    loading: boolean;
    error: string | null;
    pending: boolean;
    uploading: boolean;
    fileInput: React.RefObject<HTMLInputElement | null>;
    href: (id: string, target: string) => string;
    onNewFolder: () => void;
    onNewFile: () => void;
    onUpload: (items: { file: File; relPath: string }[]) => void;
    onDelete: (entries: DriveEntry[]) => void;
    onRename: (entry: DriveEntry, nextName: string) => void;
    /** Share a link to each of these items. Absent on a source with no saved
     *  connection behind it - a server or a running container - where a link has
     *  nothing to hang off. */
    onShare?: (entries: DriveEntry[]) => void;
    /** Share the folder that is open, which is not one of the listed entries. */
    onShareFolder?: () => void;
    /** Give one item to somebody on this instance. Absent unless the viewer owns
     *  the storage: only an owner may hand out what is on it. */
    onSharePeople?: (entry: DriveEntry) => void;
    /** The same for the folder that is open. */
    onSharePeopleFolder?: () => void;
    /** Ask somebody to drop files into a folder. Absent for the same reason. */
    onRequestFiles?: (path: string, name: string) => void;
    onToggleHidden: (entry: DriveEntry) => void;
    onSetFavorite: (entry: DriveEntry, favorite: boolean) => void;
    onSetIcon: (entry: DriveEntry, icon: string | null, color: string | null) => void;
    onSetNote: (entry: DriveEntry, note: string | null) => void;
    onMove: (entry: DriveEntry, destFolderPath: string) => void;
    onCopy: (entry: DriveEntry, destFolderPath: string) => void;
    /** Manage per-path access (ACL grants and the password lock). Owner/admin only. */
    onManageAccess?: (entry: DriveEntry) => void;
    /** Delete items for good, bypassing the recycle bin. */
    onDeletePermanent: (entries: DriveEntry[]) => void;
    onEmptyFolder: (entry: DriveEntry, permanent: boolean) => void;
    /** Schedule items to be deleted at a future time. */
    onScheduleDelete: (entries: DriveEntry[]) => void;
    /** A file was written from the viewer's editors (the file itself or a copy). */
    onSaved?: () => void;
    /** Connection-level actions (Access, Open console) rendered in the toolbar, left of the panel. */
    headerActions?: ReactNode;
}) {
    const format = useDisplayFormat();
    const [query, setQuery] = useState("");
    // Search scope: the current folder only, or a recursive walk from here.
    // Recursive by default so a search finds nested items without an extra click.
    const [searchScope, setSearchScope] = useState<"current" | "recursive">("recursive");
    const [remoteEntries, setRemoteEntries] = useState<DriveEntry[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchTruncated, setSearchTruncated] = useState(false);
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");

    /**
     * What pressing a column means.
     *
     * A different column sorts by it, ascending, because that is what somebody
     * asking for a column they were not sorted by means. The same column turns
     * the order round, which is how the direction is chosen without a control of
     * its own.
     */
    const chooseSort = (column: SortKey) => {
        if (column === sortKey) {
            setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
            return;
        }
        setSortKey(column);
        setSortDir("asc");
    };
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [starredOnly, setStarredOnly] = useState(false);
    const [categories, setCategories] = useState<Set<FileCategory>>(new Set());
    const [extFilter, setExtFilter] = useState("");
    const [minMb, setMinMb] = useState("");
    const [maxMb, setMaxMb] = useState("");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");

    const [selected, setSelected] = useState<Set<string>>(new Set());
    // Anchor for shift-range selection; keyboard cursor is tracked separately so a
    // shift+arrow can extend from a fixed anchor while the cursor keeps moving.
    const lastIndex = useRef<number | null>(null);
    const cursorRef = useRef<number | null>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    // Renaming is reached from the right-click menu, which is still trapping
    // focus when the field appears; it claims focus once the menu has gone.
    const renameField = useDeferredFocus<HTMLInputElement>(renaming !== null);
    const [viewerTarget, setViewerTarget] = useState<ViewerTarget | null>(null);
    const [showHidden, setShowHidden] = useState(false);
    const [viewMode, setViewMode] = useState<"list" | "grid">("list");
    // Breadcrumb segment currently under a drag, highlighted as a move target.
    const [dropSegment, setDropSegment] = useState<string | null>(null);
    // Folder row/cell currently under a drag, highlighted as the drop target.
    const [dropFolder, setDropFolder] = useState<string | null>(null);
    // Folder picked for upload, awaiting an in-app confirmation (not the browser's).
    const [pendingFolder, setPendingFolder] = useState<{
        name: string;
        items: UploadItem[];
    } | null>(null);
    // Actor whose profile is open from the activity feed.
    const [profileUserId, setProfileUserId] = useState<string | null>(null);
    // Items whose icon the picker is editing. A whole selection can be restyled at
    // once; the swatches preview the first one, and every item takes the pick.
    const [iconTargets, setIconTargets] = useState<DriveEntry[] | null>(null);
    const [detailsTarget, setDetailsTarget] = useState<DriveEntry | null>(null);
    const [noteTarget, setNoteTarget] = useState<DriveEntry | null>(null);
    const [noteValue, setNoteValue] = useState("");
    const [moveTargets, setMoveTargets] = useState<DriveEntry[] | null>(null);
    const [moveDest, setMoveDest] = useState("");
    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [archiveTarget, setArchiveTarget] = useState<DriveEntry | null>(null);
    const [activityLoading, setActivityLoading] = useState(false);

    // Folder weights and archive locks: measured in the background once the
    // listing itself is on screen, never blocking it, and only asked for when the
    // folder actually holds something whose answer is not already on screen. The
    // signature covers what a write would change, so the weights are measured
    // again after an upload, a delete or a rename, but not after a change that
    // only touches presentation (a star, a note, a custom icon).
    const hasInsights = entries.some(
        (entry) => entry.kind === "dir" || /\.(zip|rar)$/i.test(entry.name)
    );
    const listingRevision = useMemo(
        () => entries.map((entry) => `${entry.path}:${entry.size}:${entry.modifiedAt}`).join("|"),
        [entries]
    );
    const insights = useDriveInsights(
        connectionId,
        path,
        !loading && error === null && hasInsights,
        listingRevision
    );

    /** Measured weight of a folder, or the plain size of a file. */
    function sizeLabel(entry: DriveEntry): string {
        if (entry.kind !== "dir") return formatBytes(BigInt(entry.size));
        const weight = insights.sizes.get(entry.path);
        if (!weight) return insights.pending.has(entry.path) ? "..." : "-";
        const total = formatBytes(weight.bytes);
        return weight.partial ? `min. ${total}` : total;
    }

    /** What the size of a folder means, spelled out for the cell's tooltip. */
    function sizeTitle(entry: DriveEntry): string | undefined {
        if (entry.kind !== "dir") return undefined;
        const weight = insights.sizes.get(entry.path);
        if (!weight) {
            return insights.pending.has(entry.path) ? "Measuring this folder..." : undefined;
        }
        const files = `${weight.files} file${weight.files === 1 ? "" : "s"}`;
        const folders = `${weight.folders} folder${weight.folders === 1 ? "" : "s"}`;
        const contents = `${files} in ${folders}`;
        return weight.partial ? `${contents}. A locked folder inside was not counted.` : contents;
    }

    function openNote(entry: DriveEntry) {
        setNoteTarget(entry);
        setNoteValue(entry.note ?? "");
    }

    /** The item the icon picker highlights and previews: the first of its targets. */
    const iconPreview = iconTargets?.[0] ?? null;

    /** Give every item the picker is editing the same icon, and keep the preview. */
    function applyIcon(icon: string, color: string) {
        if (!iconTargets) return;
        for (const item of iconTargets) onSetIcon(item, icon, color);
        setIconTargets(iconTargets.map((item) => ({ ...item, icon, iconColor: color })));
    }

    /** Parent folder path of a relative path ("a/b/c" -> "a/b"). */
    function parentOf(target: string): string {
        const slash = target.lastIndexOf("/");
        return slash >= 0 ? target.slice(0, slash) : "";
    }

    /** True when moving `itemPath` into `destFolder` would nest a folder in itself. */
    function movesIntoSelf(itemPath: string, destFolder: string): boolean {
        return destFolder === itemPath || destFolder.startsWith(`${itemPath}/`);
    }

    /** Copy an item into its own folder (a duplicate gets a " copy" suffix). */
    function duplicate(entry: DriveEntry) {
        onCopy(entry, parentOf(entry.path));
    }

    function openMove(entries: DriveEntry[]) {
        setMoveTargets(entries);
        setMoveDest(path);
    }

    /** The picked destination as a clean relative path ("" is the connection root). */
    const normalizedMoveDest = moveDest.trim().replace(/^\/+|\/+$/g, "");

    /** Why the picked destination cannot be used, or null when the move is valid. */
    const moveError = ((): string | null => {
        if (!moveTargets) return null;
        if (moveTargets.some((entry) => movesIntoSelf(entry.path, normalizedMoveDest))) {
            return "A folder cannot be moved into itself.";
        }
        if (moveTargets.every((entry) => parentOf(entry.path) === normalizedMoveDest)) {
            return "Already in that folder.";
        }
        return null;
    })();

    function submitMove(event: React.FormEvent) {
        event.preventDefault();
        if (!moveTargets || moveError) return;
        for (const entry of moveTargets) onMove(entry, normalizedMoveDest);
        setMoveTargets(null);
    }
    const [dragUpload, setDragUpload] = useState(false);
    const [clipboard, setClipboard] = useState<{
        entries: DriveEntry[];
        mode: "copy" | "cut";
    } | null>(null);
    const dragPath = useRef<string | null>(null);
    const folderInput = useRef<HTMLInputElement>(null);
    const router = useRouter();

    /** Paste the clipboard into the current folder: copy duplicates, cut moves. */
    function paste() {
        pasteInto(path);
    }

    function openViewer(entry: DriveEntry) {
        // The preview takes over the listing area and the details panel beside it
        // describes what is open, so the file has to be the selected one.
        setSelected(new Set([entry.path]));
        setViewerTarget({
            connectionId,
            path: entry.path,
            name: entry.name,
            size: entry.size,
            modifiedAt: entry.modifiedAt
        });
    }

    /** Share the file the preview is showing. */
    function shareViewerTarget() {
        const entry = entries.find((item) => item.path === viewerTarget?.path);
        if (entry) onShare?.([entry]);
    }

    // Keep the open viewer's properties honest after a refresh: saving from one of
    // its editors changes the file's size and modified time. The same object is
    // returned when nothing moved, so this never re-renders on its own.
    useEffect(() => {
        setViewerTarget((current) => {
            if (!current) return current;
            const fresh = entries.find((entry) => entry.path === current.path);
            if (!fresh || (fresh.size === current.size && fresh.modifiedAt === current.modifiedAt))
                return current;
            return { ...current, size: fresh.size, modifiedAt: fresh.modifiedAt };
        });
    }, [entries]);

    /** Open an item: folders navigate, archives browse, other files preview. */
    function openEntry(entry: DriveEntry) {
        if (entry.kind === "dir") router.push(href(connectionId, entry.path));
        else if (/\.(zip|rar)$/i.test(entry.name)) setArchiveTarget(entry);
        else if (isViewable(entry.name)) openViewer(entry);
        else triggerDownload(connectionId, entry);
    }

    /** Windows-style row click: plain selects only this, ctrl toggles, shift extends. */
    function rowClick(event: MouseEvent, index: number, entry: DriveEntry) {
        if (renaming === entry.path) return;
        cursorRef.current = index;
        if (event.shiftKey) {
            selectRange(index);
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            toggleOne(entry.path);
            lastIndex.current = index;
            return;
        }
        setSelected(new Set([entry.path]));
        lastIndex.current = index;
    }

    /**
     * Renaming is deliberately NOT on a double click.
     *
     * It used to be, on the name text alone, and the hit area was the problem:
     * the thing people double-click most in a file list is a folder they want to
     * open, and the name is what their pointer is already on. Opening and
     * renaming cannot share that gesture, so renaming moved to the two places
     * that mean it - F2, and Rename in the context menu.
     */

    /** Keyboard: F2 renames, Enter opens, Delete removes, Ctrl+C/X/V copy/cut/paste. */
    function onListKeyDown(event: KeyboardEvent) {
        if (renaming) return;
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (event.key === "Escape" && selectedEntries.length > 0) {
            event.preventDefault();
            setSelected(new Set());
            cursorRef.current = null;
        } else if (mod && key === "c" && selectedEntries.length > 0) {
            event.preventDefault();
            setClipboard({ entries: selectedEntries, mode: "copy" });
        } else if (mod && key === "x" && selectedEntries.length > 0) {
            event.preventDefault();
            setClipboard({ entries: selectedEntries, mode: "cut" });
        } else if (mod && key === "v" && clipboard) {
            event.preventDefault();
            paste();
        } else if (event.key === "F2" && selectedEntries.length === 1 && selectedEntries[0]) {
            event.preventDefault();
            startRename(selectedEntries[0]);
        } else if (event.key === "Enter" && selectedEntries.length === 1 && selectedEntries[0]) {
            event.preventDefault();
            openEntry(selectedEntries[0]);
        } else if (event.key === "Delete" && selectedEntries.length > 0) {
            event.preventDefault();
            onDelete(selectedEntries);
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            moveCursor(viewMode === "grid" ? gridColumns() : 1, event.shiftKey);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveCursor(viewMode === "grid" ? -gridColumns() : -1, event.shiftKey);
        } else if (viewMode === "grid" && event.key === "ArrowRight") {
            event.preventDefault();
            moveCursor(1, event.shiftKey);
        } else if (viewMode === "grid" && event.key === "ArrowLeft") {
            event.preventDefault();
            moveCursor(-1, event.shiftKey);
        } else if (event.key === "Home") {
            event.preventDefault();
            moveCursor(-visible.length, event.shiftKey);
        } else if (event.key === "End") {
            event.preventDefault();
            moveCursor(visible.length, event.shiftKey);
        } else if (mod && key === "a") {
            event.preventDefault();
            setSelected(new Set(visible.map((entry) => entry.path)));
        }
    }

    /** External file drag over the listing highlights it as an upload drop zone. */
    function onUploadDragOver(event: React.DragEvent) {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragUpload(true);
    }

    function onUploadDrop(event: React.DragEvent) {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragUpload(false);
        // Copy the transfer synchronously; it is not available after the async walk.
        const transfer = event.dataTransfer;
        void gatherDropItems(transfer).then((items) => onUpload(items));
    }

    /**
     * Pick a folder to upload. Prefers the File System Access API, which lets us
     * enumerate the folder and confirm in our own dialog; only where it is missing
     * do we fall back to the <input webkitdirectory> that shows the browser prompt.
     */
    async function pickFolder() {
        const picker = (
            window as unknown as { showDirectoryPicker?: () => Promise<FsDirectoryHandle> }
        ).showDirectoryPicker;
        if (!picker) {
            folderInput.current?.click();
            return;
        }
        let dir: FsDirectoryHandle;
        try {
            dir = await picker();
        } catch {
            return; // The user dismissed the OS picker.
        }
        const items = await readDirectoryHandle(dir, `${dir.name}/`);
        if (items.length > 0) setPendingFolder({ name: dir.name, items });
    }

    /** Drop a dragged row onto a folder to move it there (never into itself). */
    function onFolderDrop(event: React.DragEvent, folder: DriveEntry) {
        const source = dragPath.current ?? event.dataTransfer.getData("application/x-polaris-path");
        if (!source || source === folder.path || folder.path.startsWith(`${source}/`)) {
            dragPath.current = null;
            setDropFolder(null);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        moveDraggedTo(folder.path, source);
    }

    // Create and upload shortcuts. They listen on the window so they work wherever
    // the focus sits in the explorer, and stand down whenever something else owns
    // the keyboard: a text field, an inline rename, an open dialog or menu, or the
    // file preview. Re-bound on every render, so the handler always reads current
    // state rather than a stale closure.
    useEffect(() => {
        function onShortcut(event: globalThis.KeyboardEvent) {
            if (renaming || viewerTarget || pendingFolder) return;
            if (keyboardIsBusy(event)) return;
            const shortcut = matchShortcut(event);
            if (!shortcut) return;
            if (shortcut === "new-folder" || shortcut === "new-file") {
                if (pending) return;
                event.preventDefault();
                if (shortcut === "new-folder") onNewFolder();
                else onNewFile();
                return;
            }
            if (shortcut === "request-files") {
                if (pending || !onRequestFiles) return;
                event.preventDefault();
                onRequestFiles(path, path.split("/").pop() ?? "");
                return;
            }
            if (uploading) return;
            event.preventDefault();
            if (shortcut === "upload-folder") void pickFolder();
            else fileInput.current?.click();
        }
        window.addEventListener("keydown", onShortcut);
        return () => window.removeEventListener("keydown", onShortcut);
    });

    // Selection, rename and the open preview are tied to a specific listing; drop
    // them whenever the location changes so nothing stale leaks across folders.
    useEffect(() => {
        setSelected(new Set());
        setRenaming(null);
        setViewerTarget(null);
        lastIndex.current = null;
        cursorRef.current = null;
    }, [connectionId, path]);

    // The clipboard holds paths from one connection; copy/move actions run against
    // a single connection's driver, so a cut/copy cannot be pasted into a different
    // connection. Drop it when the connection changes to avoid a silent no-op.
    useEffect(() => {
        setClipboard(null);
    }, [connectionId]);

    // Recursive search: when the scope is "recursive" and there is a query, walk
    // the subtree server-side (debounced) instead of filtering the local listing.
    useEffect(() => {
        if (searchScope !== "recursive" || !query.trim()) {
            setRemoteEntries(null);
            setSearchTruncated(false);
            setSearching(false);
            return;
        }
        const controller = new AbortController();
        setSearching(true);
        const timer = setTimeout(() => {
            const params = new URLSearchParams({ c: connectionId, q: query });
            if (path) params.set("p", path);
            fetch(`/api/drive/search?${params.toString()}`, { signal: controller.signal })
                .then((res) => res.json())
                .then((body) => {
                    if (controller.signal.aborted) return;
                    setRemoteEntries(
                        Array.isArray(body.entries) ? (body.entries as DriveEntry[]) : []
                    );
                    setSearchTruncated(Boolean(body.truncated));
                })
                .catch(() => {
                    if (!controller.signal.aborted) setRemoteEntries([]);
                })
                .finally(() => {
                    if (!controller.signal.aborted) setSearching(false);
                });
        }, 350);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [searchScope, query, connectionId, path]);

    // The rows the pipeline operates on: recursive results when searching a
    // subtree, otherwise the current folder's listing.
    const source = searchScope === "recursive" && remoteEntries !== null ? remoteEntries : entries;

    const hasFilters =
        categories.size > 0 ||
        extFilter.trim() !== "" ||
        minMb !== "" ||
        maxMb !== "" ||
        dateFrom !== "" ||
        dateTo !== "";

    const visible = useMemo(() => {
        const min = minMb ? Number(minMb) * 1024 * 1024 : null;
        const max = maxMb ? Number(maxMb) * 1024 * 1024 : null;
        const from = dateFrom ? new Date(dateFrom).getTime() : null;
        const to = dateTo ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000 : null;
        const ext = extFilter.trim().replace(/^\./, "").toLowerCase();

        let rows = source.filter((entry) => {
            if (!showHidden && entry.hidden) return false;
            if (starredOnly && !entry.favorite) return false;
            const isDir = entry.kind === "dir";
            const entryExt = isDir ? "" : extensionOf(entry.name);
            if (categories.size > 0) {
                if (isDir) return false;
                const category = categoryOfExtension(entryExt);
                if (!category || !categories.has(category)) return false;
            }
            if (ext && entryExt !== ext) return false;
            if (!isDir) {
                const size = Number(entry.size);
                if (min !== null && size < min) return false;
                if (max !== null && size > max) return false;
            }
            const modified = new Date(entry.modifiedAt).getTime();
            if (from !== null && modified < from) return false;
            if (to !== null && modified >= to) return false;
            return true;
        });

        const parsed = parseSearch(query);
        rows = rows.filter((entry) => matchesStructured(entry.name, entry.path, parsed));
        if (parsed.fuzzy) {
            // In path mode the fuzzy pass ranks against the full relative path so a
            // query like "documentos/doc.pdf" matches a nested item.
            const fuse = new Fuse(rows, {
                keys: [parsed.pathMode ? "path" : "name"],
                threshold: 0.4,
                ignoreLocation: true
            });
            rows = fuse.search(parsed.fuzzy).map((result) => result.item);
        }

        const direction = sortDir === "asc" ? 1 : -1;
        // A folder has no size of its own, so sorting by size ranks it by what the
        // background pass measured - and re-ranks it as measurements arrive.
        const weightOf = (entry: DriveEntry): number =>
            entry.kind === "dir"
                ? Number(insights.sizes.get(entry.path)?.bytes ?? 0n)
                : Number(entry.size);
        // Folders group above files; the chosen key orders within each group.
        return [...rows].sort((a, b) => {
            const dirA = a.kind === "dir" ? 0 : 1;
            const dirB = b.kind === "dir" ? 0 : 1;
            if (dirA !== dirB) return dirA - dirB;
            if (sortKey === "size") return (weightOf(a) - weightOf(b)) * direction;
            if (sortKey === "created") {
                return (
                    (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * direction
                );
            }
            if (sortKey === "modified") {
                return (
                    (new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()) *
                    direction
                );
            }
            return a.name.localeCompare(b.name) * direction;
        });
    }, [
        source,
        categories,
        extFilter,
        minMb,
        maxMb,
        dateFrom,
        dateTo,
        query,
        sortKey,
        sortDir,
        showHidden,
        starredOnly,
        insights
    ]);

    const selectedEntries = visible.filter((entry) => selected.has(entry.path));
    const allSelected = visible.length > 0 && selectedEntries.length === visible.length;
    // Anything but a single file comes down as an archive, and the button says so.
    const zipLabel =
        selectedEntries.length > 1 || selectedEntries.some((entry) => entry.kind === "dir")
            ? "Download ZIP"
            : "Download";
    // Each selected item gets its own link, so the count is worth saying out loud.
    const shareLabel =
        selectedEntries.length > 1 ? `Get ${selectedEntries.length} links` : "Get a link";
    const searchError = useMemo(() => parseSearch(query).error, [query]);

    // Items marked for a cut are shown dimmed until pasted, the way a file
    // manager greys a cut selection so it is obvious what will move.
    const cutPaths = useMemo(
        () =>
            clipboard?.mode === "cut"
                ? new Set(clipboard.entries.map((entry) => entry.path))
                : null,
        [clipboard]
    );

    /**
     * What a drag carries: the whole selection when the grabbed item belongs to it,
     * the way a file manager drags every highlighted file rather than the one under
     * the pointer; otherwise just that item.
     */
    function draggedGroup(source: string): DriveEntry[] {
        if (selected.has(source)) return selectedEntries;
        const dragged = visible.find((entry) => entry.path === source);
        return dragged ? [dragged] : [];
    }

    /**
     * Move whatever is being dragged into `targetPath` (a breadcrumb segment or a
     * folder row). Items already in the target, or a folder dropped onto itself or a
     * descendant, are skipped.
     */
    function moveDraggedTo(targetPath: string, source: string | null = dragPath.current) {
        dragPath.current = null;
        setDropSegment(null);
        setDropFolder(null);
        if (source === null) return;
        for (const item of draggedGroup(source)) {
            if (parentOf(item.path) === targetPath) continue;
            if (movesIntoSelf(item.path, targetPath)) continue;
            onMove(item, targetPath);
        }
    }

    /** Drag-and-drop handlers that turn a breadcrumb segment into a move target. */
    function segmentDropProps(targetPath: string) {
        return {
            // Walking back up is the most predictable navigation there is.
            onPointerEnter: () => prefetchListing(connectionId, targetPath),
            onDragOver: (event: React.DragEvent) => {
                if (dragPath.current === null) return;
                event.preventDefault();
                setDropSegment(targetPath);
            },
            onDragLeave: () => setDropSegment((prev) => (prev === targetPath ? null : prev)),
            onDrop: (event: React.DragEvent) => {
                event.preventDefault();
                moveDraggedTo(targetPath);
            }
        };
    }

    /** Drag handlers shared by list rows and grid cells: drag to move, drop onto a folder. */
    function entryDragProps(entry: DriveEntry, isRenaming: boolean) {
        // A folder is a valid drop target for the current drag unless it is the
        // dragged item itself or one of its descendants (which would be a cycle).
        const droppableFor = (source: string | null): boolean =>
            entry.kind === "dir" &&
            source !== null &&
            source !== entry.path &&
            !entry.path.startsWith(`${source}/`);
        return {
            draggable: !isRenaming,
            // The cursor settling on a folder is the cheapest warning that it is
            // about to be opened, and a listing fetched now is a listing nobody
            // waits for. Files have nothing to prefetch.
            onPointerEnter:
                entry.kind === "dir" ? () => prefetchListing(connectionId, entry.path) : undefined,
            onDragStart: (event: React.DragEvent) => {
                dragPath.current = entry.path;
                event.dataTransfer.setData("application/x-polaris-path", entry.path);
                event.dataTransfer.effectAllowed = "move";
                const carried = draggedGroup(entry.path).length;
                if (carried > 1) showCountDragImage(event, carried);
            },
            onDragEnd: () => {
                dragPath.current = null;
                setDropFolder(null);
            },
            onDragOver:
                entry.kind === "dir"
                    ? (event: React.DragEvent) => {
                          if (!droppableFor(dragPath.current)) return;
                          event.preventDefault();
                          setDropFolder(entry.path);
                      }
                    : undefined,
            onDragLeave:
                entry.kind === "dir"
                    ? () => setDropFolder((prev) => (prev === entry.path ? null : prev))
                    : undefined,
            onDrop:
                entry.kind === "dir"
                    ? (event: React.DragEvent) => onFolderDrop(event, entry)
                    : undefined
        };
    }

    /**
     * What a right-click acts on: the whole selection when the clicked item is part
     * of it, otherwise that item alone. Every file manager works this way, and it
     * is the only rule under which an action never quietly reaches something the
     * pointer was never on.
     */
    function menuTargets(entry: DriveEntry): DriveEntry[] {
        return selected.has(entry.path) && selectedEntries.length > 1 ? selectedEntries : [entry];
    }

    /**
     * Right-clicking outside the selection moves the selection onto that item
     * before its menu opens, so what the menu is about to act on is what is
     * highlighted. Clicking inside the selection leaves it alone.
     */
    function adoptForMenu(index: number, entry: DriveEntry) {
        if (selected.has(entry.path)) return;
        setSelected(new Set([entry.path]));
        lastIndex.current = index;
        cursorRef.current = index;
    }

    /** Paste the clipboard into a folder in the listing rather than the open one. */
    function pasteInto(destFolder: string) {
        if (!clipboard) return;
        for (const item of clipboard.entries) {
            if (movesIntoSelf(item.path, destFolder)) continue;
            if (clipboard.mode === "cut") onMove(item, destFolder);
            else onCopy(item, destFolder);
        }
        if (clipboard.mode === "cut") setClipboard(null);
    }

    /** The right-click menu for an entry, shared by the list and grid views. It
     *  covers the whole selection when the entry belongs to one, so the items that
     *  only make sense for a single thing (open, rename, notes, details) drop out.
     *  Rename puts an input where the name was, so the menu leaves focus there
     *  instead of taking it back and blurring the field away. */
    function entryMenu(entry: DriveEntry) {
        const targets = menuTargets(entry);
        const many = targets.length > 1;
        const label = many ? `${targets.length} items selected` : entry.name;
        // A mixed selection commits to one direction rather than flipping each
        // item: anything not yet starred/hidden decides, so a second pass undoes
        // the first instead of leaving the group half-and-half.
        const starring = targets.some((item) => !item.favorite);
        const hiding = targets.some((item) => !item.hidden);
        return (
            <ContextMenuContent onCloseAutoFocus={keepFocusOnClose}>
                <ContextMenuLabel>{label}</ContextMenuLabel>
                {many ? (
                    <ContextMenuItem onSelect={() => downloadSelection(connectionId, targets)}>
                        <Download className="size-4" />
                        Download as ZIP
                    </ContextMenuItem>
                ) : entry.kind === "dir" ? (
                    <>
                        <ContextMenuItem asChild>
                            <Link href={href(connectionId, entry.path)}>
                                <Folder className="size-4" />
                                Open
                            </Link>
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => downloadSelection(connectionId, [entry])}>
                            <Download className="size-4" />
                            Download as ZIP
                        </ContextMenuItem>
                        {onRequestFiles ? (
                            <ContextMenuItem
                                onSelect={() => onRequestFiles(entry.path, entry.name)}
                            >
                                <Inbox className="size-4" />
                                Request files here
                            </ContextMenuItem>
                        ) : null}
                        {clipboard ? (
                            <ContextMenuItem onSelect={() => pasteInto(entry.path)}>
                                <ClipboardPaste className="size-4" />
                                Paste here
                                {clipboard.entries.length > 1
                                    ? ` (${clipboard.entries.length})`
                                    : ""}
                            </ContextMenuItem>
                        ) : null}
                    </>
                ) : (
                    <>
                        {isViewable(entry.name) ? (
                            <ContextMenuItem onSelect={() => openViewer(entry)}>
                                <Eye className="size-4" />
                                Open
                            </ContextMenuItem>
                        ) : null}
                        <ContextMenuItem onSelect={() => triggerDownload(connectionId, entry)}>
                            <Download className="size-4" />
                            Download
                        </ContextMenuItem>
                        {/\.(zip|rar)$/i.test(entry.name) ? (
                            <ContextMenuItem onSelect={() => setArchiveTarget(entry)}>
                                <FileArchive className="size-4" />
                                Open archive
                            </ContextMenuItem>
                        ) : null}
                    </>
                )}
                {many ? null : (
                    <ContextMenuItem onSelect={() => startRename(entry)}>
                        <Pencil className="size-4" />
                        Rename
                        <MenuShortcut>F2</MenuShortcut>
                    </ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => setClipboard({ entries: targets, mode: "copy" })}>
                    <Copy className="size-4" />
                    {many ? `Copy ${targets.length} items` : "Copy"}
                    <MenuShortcut>Ctrl+C</MenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setClipboard({ entries: targets, mode: "cut" })}>
                    <Scissors className="size-4" />
                    {many ? `Cut ${targets.length} items` : "Cut"}
                    <MenuShortcut>Ctrl+X</MenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() => {
                        for (const item of targets) duplicate(item);
                    }}
                >
                    <Files className="size-4" />
                    Duplicate
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => openMove(targets)}>
                    <FolderInput className="size-4" />
                    Move to...
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() =>
                        void navigator.clipboard.writeText(
                            targets.map((item) => item.path).join("\n")
                        )
                    }
                >
                    <ClipboardCopy className="size-4" />
                    {many ? "Copy paths" : "Copy path"}
                </ContextMenuItem>
                {onSharePeople && !many ? (
                    <ContextMenuItem onSelect={() => onSharePeople(entry)}>
                        <Users className="size-4" />
                        Share with people
                    </ContextMenuItem>
                ) : null}
                {onShare ? (
                    <ContextMenuItem onSelect={() => onShare(targets)}>
                        <Share2 className="size-4" />
                        {many ? `Get ${targets.length} links` : "Get a link"}
                    </ContextMenuItem>
                ) : null}
                <ContextMenuSeparator />
                <ContextMenuItem
                    onSelect={() => {
                        for (const item of targets) onSetFavorite(item, starring);
                    }}
                >
                    <Star className={cn("size-4", !starring && "fill-amber-400 text-amber-400")} />
                    {starring ? "Add to favorites" : "Remove from favorites"}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setIconTargets(targets)}>
                    <Palette className="size-4" />
                    Change icon
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() => {
                        for (const item of targets) {
                            if (item.hidden !== hiding) onToggleHidden(item);
                        }
                    }}
                >
                    {hiding ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    {hiding ? "Hide" : "Unhide"}
                </ContextMenuItem>
                {many ? null : (
                    <>
                        <ContextMenuItem onSelect={() => openNote(entry)}>
                            <StickyNote className="size-4" />
                            {entry.note ? "Edit note" : "Add note"}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => setDetailsTarget(entry)}>
                            <Info className="size-4" />
                            Details
                        </ContextMenuItem>
                        {onManageAccess ? (
                            <ContextMenuItem onSelect={() => onManageAccess(entry)}>
                                <ShieldCheck className="size-4" />
                                Permissions &amp; lock
                            </ContextMenuItem>
                        ) : null}
                    </>
                )}
                <ContextMenuSeparator />
                <ContextMenuSub>
                    <ContextMenuSubTrigger className="text-danger data-[state=open]:bg-danger/10 focus:bg-danger/10">
                        <Trash2 className="size-4" />
                        Delete
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        <ContextMenuItem onSelect={() => onDelete(targets)}>
                            <Trash2 className="size-4" />
                            Move to Trash
                            <MenuShortcut>Del</MenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem
                            variant="danger"
                            onSelect={() => onDeletePermanent(targets)}
                        >
                            <Trash2 className="size-4" />
                            Delete permanently
                        </ContextMenuItem>
                        {!many && entry.kind === "dir" ? (
                            <>
                                <ContextMenuSeparator />
                                <ContextMenuItem onSelect={() => onEmptyFolder(entry, false)}>
                                    <Eraser className="size-4" />
                                    Empty folder to Trash
                                </ContextMenuItem>
                                <ContextMenuItem
                                    variant="danger"
                                    onSelect={() => onEmptyFolder(entry, true)}
                                >
                                    <Eraser className="size-4" />
                                    Empty folder permanently
                                </ContextMenuItem>
                            </>
                        ) : null}
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            variant="danger"
                            onSelect={() => onScheduleDelete(targets)}
                        >
                            <CalendarClock className="size-4" />
                            Delete later...
                        </ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>
            </ContextMenuContent>
        );
    }

    // Load the activity feed for a single selected item (downloads, renames, ...).
    const singleSelectedPath =
        selectedEntries.length === 1 ? (selectedEntries[0]?.path ?? null) : null;
    useEffect(() => {
        if (!singleSelectedPath) {
            setActivity([]);
            return;
        }
        const controller = new AbortController();
        // Clicking back onto a file shows what its history said moments ago rather
        // than an empty panel and another query.
        const key = activityKey(connectionId, singleSelectedPath);
        const cached = readSnapshot<ActivityItem[]>(key, ACTIVITY_CACHE_TTL_MS)?.value;
        if (cached) setActivity(cached);
        setActivityLoading(!cached);
        const params = new URLSearchParams({ c: connectionId, p: singleSelectedPath });
        fetch(`/api/drive/activity?${params.toString()}`, { signal: controller.signal })
            .then((res) => res.json())
            .then((body) => {
                if (controller.signal.aborted) return;
                const items = Array.isArray(body.items) ? (body.items as ActivityItem[]) : [];
                setActivity(items);
                writeSnapshot(key, items);
            })
            .catch(() => {
                if (!controller.signal.aborted) setActivity([]);
            })
            .finally(() => {
                if (!controller.signal.aborted) setActivityLoading(false);
            });
        return () => controller.abort();
    }, [connectionId, singleSelectedPath]);

    /**
     * How far the listing has to reach for the empty space under the last file to
     * still belong to the folder.
     *
     * In a file manager a right press below the rows offers "new folder", not the
     * browser's menu - and a drop there uploads. This page scrolls as a document,
     * so the listing was only as tall as its rows: with four files in a folder,
     * everything below the fourth row was outside the region entirely, and the
     * gesture people reach for first did nothing.
     *
     * Measured rather than written as a fraction of the viewport, because where
     * the listing starts depends on how many lines the breadcrumb and the toolbar
     * above it wrapped onto - which changes with the window and with the path.
     * The document position is what is measured (viewport top plus how far the
     * page is scrolled), so the answer does not move as the page scrolls under
     * it.
     */
    const listingRef = useRef<HTMLDivElement>(null);
    const [listingFloor, setListingFloor] = useState(0);
    useEffect(() => {
        const measure = () => {
            const element = listingRef.current;
            if (!element) return;
            const top = element.getBoundingClientRect().top + window.scrollY;
            setListingFloor(Math.max(0, Math.round(window.innerHeight - top - 16)));
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
        // Re-measured whenever the rows above it can have reflowed. The value only
        // ever decides how much empty space the folder owns, so a stale one costs
        // nothing until the next of these.
    }, [path, viewMode, loading, visible.length, selectedEntries.length]);

    // Windowed rendering: only the rows in view (plus a small overscan) are in the
    // DOM, so a folder with millions of entries scrolls smoothly - rows that leave
    // the viewport are removed and new ones added as you scroll.
    const scrollRef = useRef<HTMLDivElement>(null);
    const rowVirtualizer = useVirtualizer({
        count: visible.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 40,
        overscan: 12
    });

    // Marquee (rubber-band) selection. Rows are a fixed 40px tall, so the dragged
    // rectangle maps to a contiguous index range by simple arithmetic - which also
    // makes it work with virtualization (rows outside the viewport are not in the
    // DOM but their indices still fall inside the band). The base selection is
    // captured on mouse-down so Ctrl-drag adds to the existing selection.
    const ROW_HEIGHT = 40;
    const marqueeStart = useRef<number | null>(null);
    const marqueeBase = useRef<Set<string>>(new Set());
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const [marqueeRect, setMarqueeRect] = useState<{ top: number; height: number } | null>(null);
    const [marqueeActive, setMarqueeActive] = useState(false);

    /** Y within the scroll content (accounts for how far the list is scrolled). */
    function contentY(clientY: number): number {
        const el = scrollRef.current;
        if (!el) return 0;
        return clientY - el.getBoundingClientRect().top + el.scrollTop;
    }

    /** Begin a marquee when the press lands on empty space, not on a row. */
    function onMarqueeDown(event: MouseEvent) {
        if (event.button !== 0) return;
        const el = scrollRef.current;
        if (!el) return;
        // Ignore presses on the scrollbar gutter and on any row (rows handle their
        // own click/drag).
        if (event.nativeEvent.offsetX >= el.clientWidth) return;
        if ((event.target as HTMLElement).closest("[data-drive-row]")) return;
        const y = contentY(event.clientY);
        marqueeStart.current = y;
        marqueeBase.current = event.ctrlKey || event.metaKey ? new Set(selected) : new Set();
        if (!(event.ctrlKey || event.metaKey)) setSelected(new Set());
        setMarqueeRect({ top: y, height: 0 });
        setMarqueeActive(true);
        event.preventDefault();
    }

    useEffect(() => {
        if (!marqueeActive) return;
        function move(event: globalThis.MouseEvent) {
            if (marqueeStart.current === null) return;
            const y = contentY(event.clientY);
            const top = Math.min(marqueeStart.current, y);
            const bottom = Math.max(marqueeStart.current, y);
            setMarqueeRect({ top, height: bottom - top });
            const rows = visibleRef.current;
            const lo = Math.max(0, Math.floor(top / ROW_HEIGHT));
            const hi = Math.min(rows.length - 1, Math.floor(bottom / ROW_HEIGHT));
            const next = new Set(marqueeBase.current);
            for (let index = lo; index <= hi; index++) {
                const entry = rows[index];
                if (entry) next.add(entry.path);
            }
            setSelected(next);
        }
        function up() {
            marqueeStart.current = null;
            setMarqueeActive(false);
            setMarqueeRect(null);
        }
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
    }, [marqueeActive]);

    function toggleCategory(id: FileCategory) {
        setCategories((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function selectRange(toIndex: number) {
        const from = lastIndex.current ?? toIndex;
        const [lo, hi] = from < toIndex ? [from, toIndex] : [toIndex, from];
        setSelected((prev) => {
            const next = new Set(prev);
            for (let i = lo; i <= hi; i++) {
                const entry = visible[i];
                if (entry) next.add(entry.path);
            }
            return next;
        });
    }

    function toggleOne(pathKey: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(pathKey)) next.delete(pathKey);
            else next.add(pathKey);
            return next;
        });
    }

    /** Select exactly the contiguous range between two indices (keyboard shift-extend). */
    function setRangeSelection(a: number, b: number) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const next = new Set<string>();
        for (let i = lo; i <= hi; i++) {
            const entry = visible[i];
            if (entry) next.add(entry.path);
        }
        setSelected(next);
    }

    /** Columns currently shown in grid view, measured from the first row's layout. */
    function gridColumns(): number {
        const grid = gridRef.current;
        if (!grid || grid.children.length === 0) return 1;
        const top = (grid.children[0] as HTMLElement).offsetTop;
        let cols = 0;
        for (const child of Array.from(grid.children)) {
            if ((child as HTMLElement).offsetTop === top) cols++;
            else break;
        }
        return Math.max(1, cols);
    }

    /** Bring the keyboard cursor into view in whichever layout is active. */
    function scrollCursorIntoView(index: number) {
        if (viewMode === "grid") {
            (gridRef.current?.children[index] as HTMLElement | undefined)?.scrollIntoView({
                block: "nearest"
            });
        } else {
            rowVirtualizer.scrollToIndex(index, { align: "auto" });
        }
    }

    /**
     * Move the keyboard cursor by `delta` positions (a row in list view, a row or
     * column in grid view). Plain move selects just that item; holding shift extends
     * the selection from the anchor, mirroring a file manager's arrow-key behavior.
     */
    function moveCursor(delta: number, extend: boolean) {
        if (visible.length === 0) return;
        const start =
            cursorRef.current ??
            lastIndex.current ??
            (selectedEntries[0] ? visible.indexOf(selectedEntries[0]) : -1);
        const next =
            start < 0
                ? delta > 0
                    ? 0
                    : visible.length - 1
                : Math.max(0, Math.min(visible.length - 1, start + delta));
        cursorRef.current = next;
        if (extend) {
            setRangeSelection(lastIndex.current ?? next, next);
        } else {
            const entry = visible[next];
            if (entry) setSelected(new Set([entry.path]));
            lastIndex.current = next;
        }
        scrollCursorIntoView(next);
    }

    /** Ctrl/Cmd toggles, Shift extends a range - shared by the checkbox and name. */
    function handleSelectClick(event: MouseEvent, index: number, entry: DriveEntry) {
        if (event.shiftKey) {
            event.preventDefault();
            selectRange(index);
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            toggleOne(entry.path);
            lastIndex.current = index;
            return;
        }
        // Plain checkbox click: toggle just this row.
        toggleOne(entry.path);
        lastIndex.current = index;
    }

    function toggleAll() {
        setSelected(allSelected ? new Set() : new Set(visible.map((entry) => entry.path)));
    }

    function startRename(entry: DriveEntry) {
        setRenaming(entry.path);
        setRenameValue(entry.name);
    }

    function submitRename(entry: DriveEntry) {
        const next = renameValue.trim();
        setRenaming(null);
        if (next && next !== entry.name) onRename(entry, next);
    }

    function onRenameKey(event: KeyboardEvent<HTMLInputElement>, entry: DriveEntry) {
        if (event.key === "Enter") submitRename(entry);
        else if (event.key === "Escape") setRenaming(null);
    }

    return (
        <>
            {viewerTarget ? (
                <div className="flex min-w-0 flex-1 flex-col lg:pr-72">
                    <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <Button size="sm" variant="ghost" onClick={() => setViewerTarget(null)}>
                                <ChevronLeft className="size-4" />
                                Back
                            </Button>
                            <span className="min-w-0 truncate text-sm font-medium">
                                {viewerTarget.name}
                            </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            {onShare ? (
                                <Button size="sm" variant="ghost" onClick={shareViewerTarget}>
                                    <Share2 className="size-4" />
                                    Get a link
                                </Button>
                            ) : null}
                            <Button asChild size="sm" variant="secondary">
                                <a
                                    href={downloadUrl(connectionId, viewerTarget.path)}
                                    download={viewerTarget.name}
                                >
                                    <Download className="size-4" />
                                    Download
                                </a>
                            </Button>
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface/40">
                        <FilePreview target={viewerTarget} onSaved={onSaved} />
                    </div>
                </div>
            ) : null}
            <div
                className={cn(
                    "flex min-w-0 flex-1 flex-col",
                    selectedEntries.length === 1 && "lg:pr-72",
                    viewerTarget && "hidden"
                )}
            >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
                        <Link
                            href={href(connectionId, rootPath)}
                            {...segmentDropProps(rootPath)}
                            className={cn(
                                "rounded px-1 py-0.5 hover:text-foreground",
                                dropSegment === rootPath &&
                                    "bg-primary/15 text-primary ring-1 ring-primary/40"
                            )}
                        >
                            {/* A location of your own starts at Home. One somebody
                                shared starts at what they shared, and calling that
                                Home would say the folder is the whole storage. */}
                            {rootPath === "" ? "Home" : (rootPath.split("/").pop() ?? "Home")}
                        </Link>
                        {segments.slice(depthOf(rootPath)).map((segment, index) => {
                            const target = segments
                                .slice(0, depthOf(rootPath) + index + 1)
                                .join("/");
                            return (
                                <span key={target} className="flex items-center gap-1">
                                    <ChevronRight className="size-3" />
                                    <Link
                                        href={href(connectionId, target)}
                                        {...segmentDropProps(target)}
                                        className={cn(
                                            "truncate rounded px-1 py-0.5 hover:text-foreground",
                                            dropSegment === target &&
                                                "bg-primary/15 text-primary ring-1 ring-primary/40"
                                        )}
                                    >
                                        {segment}
                                    </Link>
                                </span>
                            );
                        })}
                    </div>
                    {/* Below `sm` these are the icons alone: the row carries up to six
                        actions, and their labels together are wider than a phone. */}
                    <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
                        {headerActions}
                        {clipboard ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={paste}
                                disabled={pending}
                                title={`Paste ${clipboard.entries.length} items`}
                                aria-label={`Paste ${clipboard.entries.length} items`}
                            >
                                <ClipboardPaste className="size-4" />
                                <span className="hidden sm:inline">
                                    Paste ({clipboard.entries.length})
                                </span>
                            </Button>
                        ) : null}
                        {onSharePeopleFolder ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={onSharePeopleFolder}
                                disabled={pending}
                                title="Share this folder with people"
                                aria-label="Share this folder with people"
                            >
                                <Users className="size-4" />
                                <span className="hidden sm:inline">Share</span>
                            </Button>
                        ) : null}
                        {onShareFolder ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={onShareFolder}
                                disabled={pending}
                                title="Get a link to this folder"
                                aria-label="Get a link to this folder"
                            >
                                <Link2 className="size-4" />
                            </Button>
                        ) : null}
                        {onRequestFiles ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    onRequestFiles(path, segments[segments.length - 1] ?? "")
                                }
                                disabled={pending}
                                title={`Request files (${SHORTCUT_HINTS["request-files"]})`}
                                aria-label="Request files"
                            >
                                <Inbox className="size-4" />
                                <span className="hidden sm:inline">Request files</span>
                            </Button>
                        ) : null}
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={onNewFolder}
                            disabled={pending}
                            title={`New folder (${SHORTCUT_HINTS["new-folder"]})`}
                            aria-label="New folder"
                        >
                            <FolderPlus className="size-4" />
                            <span className="hidden sm:inline">New folder</span>
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={uploading}
                                    title="Upload"
                                    aria-label="Upload"
                                >
                                    <Upload className="size-4" />
                                    <span className="hidden sm:inline">
                                        {uploading ? "Uploading..." : "Upload"}
                                    </span>
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                                    <Upload className="size-4" />
                                    Files
                                    <MenuShortcut>{SHORTCUT_HINTS["upload-files"]}</MenuShortcut>
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => void pickFolder()}>
                                    <FolderUp className="size-4" />
                                    Folder
                                    <MenuShortcut>{SHORTCUT_HINTS["upload-folder"]}</MenuShortcut>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <input
                            ref={fileInput}
                            type="file"
                            multiple
                            hidden
                            onChange={(event) => {
                                if (event.target.files) onUpload(filesToItems(event.target.files));
                            }}
                        />
                        <input
                            ref={(element) => {
                                folderInput.current = element;
                                // webkitdirectory is not a standard React prop; set it directly.
                                if (element) element.setAttribute("webkitdirectory", "");
                            }}
                            type="file"
                            hidden
                            onChange={(event) => {
                                if (event.target.files) onUpload(filesToItems(event.target.files));
                                if (folderInput.current) folderInput.current.value = "";
                            }}
                        />
                    </div>
                </div>

                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[12rem] flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search - try *.pdf, ext:pptx,pdf, /regex/"
                            title="Wildcards (*, ?), ext:pptx,pdf for extensions, /pattern/ for regex, or plain text for a fuzzy match"
                            className={cn("pl-8 pr-9", searchError && "border-danger")}
                        />
                        <button
                            type="button"
                            onClick={() =>
                                setSearchScope((prev) =>
                                    prev === "current" ? "recursive" : "current"
                                )
                            }
                            aria-label="Toggle search scope"
                            title={
                                searchScope === "recursive"
                                    ? "Searching this folder and all subfolders. Click to search only this folder."
                                    : "Searching only this folder. Click to search all subfolders too."
                            }
                            className={cn(
                                "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition-colors hover:bg-muted",
                                searchScope === "recursive"
                                    ? "text-primary"
                                    : "text-muted-foreground"
                            )}
                        >
                            {searchScope === "recursive" ? (
                                <FolderTreeIcon className="size-4" />
                            ) : (
                                <Folder className="size-4" />
                            )}
                        </button>
                    </div>
                    {/* Four buttons naming the columns, beside a table whose
                        columns are already named, is the same four words twice -
                        and the toolbar is where everything else that has nowhere
                        better to be already lives. In the list the sort belongs
                        on the heading of the column it sorts, which is where
                        every table anybody has used puts it.

                        The grid has no headings, so it keeps a control - one
                        menu rather than a row of buttons, since there is nothing
                        on screen for it to be redundant with. */}
                    {viewMode === "grid" ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    aria-label={`Sorted by ${SORT_LABELS[sortKey].toLowerCase()}, ${sortDir === "asc" ? "ascending" : "descending"}`}
                                    title="Sort"
                                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    <ArrowUpDown className="size-4 shrink-0" />
                                    {SORT_LABELS[sortKey]}
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-[11rem]">
                                {SORT_KEYS.map((key) => (
                                    <DropdownMenuItem
                                        key={key}
                                        onSelect={() => chooseSort(key)}
                                        className="gap-2"
                                    >
                                        {SORT_LABELS[key]}
                                        {sortKey === key ? (
                                            <span className="ml-auto pl-6 text-[0.6875rem] text-foreground-subtle">
                                                {sortDir === "asc" ? "A-Z" : "Z-A"}
                                            </span>
                                        ) : null}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                        <button
                            type="button"
                            onClick={() => setViewMode("list")}
                            aria-label="List view"
                            title="List view"
                            className={cn(
                                "rounded p-1 transition-colors hover:bg-muted",
                                viewMode === "list"
                                    ? "bg-muted text-foreground"
                                    : "text-muted-foreground"
                            )}
                        >
                            <List className="size-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setViewMode("grid")}
                            aria-label="Grid view"
                            title="Grid view"
                            className={cn(
                                "rounded p-1 transition-colors hover:bg-muted",
                                viewMode === "grid"
                                    ? "bg-muted text-foreground"
                                    : "text-muted-foreground"
                            )}
                        >
                            <LayoutGrid className="size-4" />
                        </button>
                    </div>
                    <Button
                        size="sm"
                        variant={hasFilters ? "secondary" : "ghost"}
                        onClick={() => setFiltersOpen((prev) => !prev)}
                    >
                        <SlidersHorizontal className="size-4" />
                        Filters
                        {hasFilters ? (
                            <Badge variant="neutral">{categories.size + (extFilter ? 1 : 0)}</Badge>
                        ) : null}
                    </Button>
                    <Button
                        size="sm"
                        variant={starredOnly ? "secondary" : "ghost"}
                        onClick={() => setStarredOnly((prev) => !prev)}
                        aria-label={starredOnly ? "Show all items" : "Show starred only"}
                    >
                        <Star
                            className={cn("size-4", starredOnly && "fill-amber-400 text-amber-400")}
                        />
                        Starred
                    </Button>
                    <Button
                        size="sm"
                        variant={showHidden ? "secondary" : "ghost"}
                        onClick={() => setShowHidden((prev) => !prev)}
                        aria-label={showHidden ? "Hide hidden items" : "Show hidden items"}
                    >
                        {showHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        Hidden
                    </Button>
                </div>

                {searchScope === "recursive" && query.trim() ? (
                    <p className="mb-3 -mt-1 text-xs text-muted-foreground">
                        {searching
                            ? "Searching this folder and all subfolders..."
                            : `${visible.length} result${visible.length === 1 ? "" : "s"} across subfolders${
                                  searchTruncated
                                      ? " (first matches only - narrow your search)"
                                      : ""
                              }`}
                    </p>
                ) : null}

                {filtersOpen ? (
                    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-3">
                        <div className="flex flex-wrap gap-1.5">
                            {FILE_CATEGORIES.map((category) => (
                                <button
                                    key={category.id}
                                    type="button"
                                    onClick={() => toggleCategory(category.id)}
                                    className={cn(
                                        "rounded-full border px-3 py-1 text-xs transition-colors",
                                        categories.has(category.id)
                                            ? "border-primary bg-primary/10 text-primary"
                                            : "border-border text-muted-foreground hover:bg-muted"
                                    )}
                                >
                                    {category.label}
                                </button>
                            ))}
                        </div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                Extension
                                <Input
                                    value={extFilter}
                                    onChange={(e) => setExtFilter(e.target.value)}
                                    placeholder="pdf"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                Min size (MB)
                                <Input
                                    value={minMb}
                                    onChange={(e) => setMinMb(e.target.value)}
                                    type="number"
                                    min="0"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                Max size (MB)
                                <Input
                                    value={maxMb}
                                    onChange={(e) => setMaxMb(e.target.value)}
                                    type="number"
                                    min="0"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                Modified after
                                <Input
                                    value={dateFrom}
                                    onChange={(e) => setDateFrom(e.target.value)}
                                    type="date"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                Modified before
                                <Input
                                    value={dateTo}
                                    onChange={(e) => setDateTo(e.target.value)}
                                    type="date"
                                />
                            </label>
                        </div>
                        {hasFilters ? (
                            <button
                                type="button"
                                onClick={() => {
                                    setCategories(new Set());
                                    setExtFilter("");
                                    setMinMb("");
                                    setMaxMb("");
                                    setDateFrom("");
                                    setDateTo("");
                                }}
                                className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                            >
                                Clear filters
                            </button>
                        ) : null}
                    </div>
                ) : null}

                {/* Always-present, fixed-height action row so beginning a selection
                never reflows the list. Empty (a subtle hint) when nothing is
                selected; actions appear in place when items are selected. */}
                <div
                    className={cn(
                        "mb-3 flex h-10 items-center gap-2 rounded-md border px-3 text-sm transition-colors",
                        selectedEntries.length > 0
                            ? "border-primary/40 bg-primary/5"
                            : "border-transparent"
                    )}
                >
                    {selectedEntries.length > 0 ? (
                        <>
                            <span className="shrink-0 font-medium">
                                {selectedEntries.length} selected
                            </span>
                            <div className="ml-auto flex items-center gap-1">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => downloadSelection(connectionId, selectedEntries)}
                                    title={zipLabel}
                                    aria-label={zipLabel}
                                >
                                    <Download className="size-4" />
                                    <span className="hidden sm:inline">{zipLabel}</span>
                                </Button>
                                <SelectionZipMenu
                                    connectionId={connectionId}
                                    entries={selectedEntries}
                                    currentPath={path}
                                />
                                {onShare ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onShare(selectedEntries)}
                                        title={shareLabel}
                                        aria-label={shareLabel}
                                    >
                                        <Share2 className="size-4" />
                                        <span className="hidden sm:inline">Share</span>
                                    </Button>
                                ) : null}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => onDelete(selectedEntries)}
                                    disabled={pending}
                                    title="Delete"
                                    aria-label="Delete"
                                >
                                    <Trash2 className="size-4" />
                                    <span className="hidden sm:inline">Delete</span>
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setSelected(new Set())}
                                    title="Clear selection"
                                    aria-label="Clear selection"
                                >
                                    <X className="size-4" />
                                    <span className="hidden sm:inline">Clear</span>
                                </Button>
                            </div>
                        </>
                    ) : (
                        <span className="text-xs text-muted-foreground">
                            Select files to download, zip, or delete them.
                        </span>
                    )}
                </div>

                <ContextMenu>
                    <ContextMenuTrigger asChild>
                        <div
                            ref={listingRef}
                            tabIndex={0}
                            onKeyDown={onListKeyDown}
                            style={listingFloor > 0 ? { minHeight: listingFloor } : undefined}
                            className={cn(
                                "relative min-w-0 flex-1 rounded-lg ",
                                dragUpload && "ring-2 ring-primary ring-offset-2 "
                            )}
                            onDragOver={onUploadDragOver}
                            onDragLeave={() => setDragUpload(false)}
                            onDrop={onUploadDrop}
                        >
                            {loading ? (
                                <ListingSkeleton viewMode={viewMode} />
                            ) : error ? (
                                <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                                    {error}
                                </div>
                            ) : (
                                <div>
                                    {viewMode === "list" ? (
                                        <div className="flex h-9 items-center border-b border-border text-left text-xs font-medium text-muted-foreground">
                                            <div className="flex w-9 shrink-0 items-center justify-center">
                                                <label className="flex cursor-pointer items-center">
                                                    <Checkbox
                                                        checked={allSelected}
                                                        indeterminate={
                                                            !allSelected &&
                                                            selectedEntries.length > 0
                                                        }
                                                        onChange={toggleAll}
                                                        aria-label="Select all"
                                                    />
                                                </label>
                                            </div>
                                            <SortHeading
                                                column="name"
                                                sortKey={sortKey}
                                                sortDir={sortDir}
                                                onChoose={chooseSort}
                                                className="min-w-0 flex-1 px-1"
                                            />
                                            <SortHeading
                                                column="created"
                                                sortKey={sortKey}
                                                sortDir={sortDir}
                                                onChoose={chooseSort}
                                                className="hidden w-44 shrink-0 px-2 lg:flex"
                                            />
                                            <SortHeading
                                                column="modified"
                                                sortKey={sortKey}
                                                sortDir={sortDir}
                                                onChoose={chooseSort}
                                                className="hidden w-44 shrink-0 px-2 sm:flex"
                                            />
                                            <SortHeading
                                                column="size"
                                                sortKey={sortKey}
                                                sortDir={sortDir}
                                                onChoose={chooseSort}
                                                className="w-24 shrink-0 px-2"
                                            />
                                            <div className="w-12 shrink-0 px-2" />
                                        </div>
                                    ) : null}
                                    {visible.length === 0 ? (
                                        <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                                            {searchScope === "recursive" && query.trim()
                                                ? searching
                                                    ? "Searching..."
                                                    : "No matches in this folder or its subfolders."
                                                : source.length === 0
                                                  ? "This folder is empty."
                                                  : "Nothing matches your search or filters."}
                                        </p>
                                    ) : viewMode === "grid" ? (
                                        <div className="max-h-[65vh] overflow-auto p-1">
                                            <div
                                                ref={gridRef}
                                                className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6"
                                            >
                                                {visible.map((entry, index) => {
                                                    const isSelected = selected.has(entry.path);
                                                    const isRenaming = renaming === entry.path;
                                                    return (
                                                        <ContextMenu key={entry.path}>
                                                            <ContextMenuTrigger asChild>
                                                                <div
                                                                    data-drive-row
                                                                    onClick={(event) =>
                                                                        rowClick(
                                                                            event,
                                                                            index,
                                                                            entry
                                                                        )
                                                                    }
                                                                    onContextMenu={() =>
                                                                        adoptForMenu(index, entry)
                                                                    }
                                                                    onDoubleClick={() => {
                                                                        if (!isRenaming)
                                                                            openEntry(entry);
                                                                    }}
                                                                    {...entryDragProps(
                                                                        entry,
                                                                        isRenaming
                                                                    )}
                                                                    className={cn(
                                                                        "group relative flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors",
                                                                        isSelected
                                                                            ? "border-primary/40 bg-primary/5"
                                                                            : "border-transparent hover:bg-card-hover",
                                                                        entry.hidden &&
                                                                            "opacity-50",
                                                                        cutPaths?.has(entry.path) &&
                                                                            "opacity-40",
                                                                        dropFolder === entry.path &&
                                                                            "border-primary bg-primary/10 ring-2 ring-primary"
                                                                    )}
                                                                >
                                                                    <GridIcon
                                                                        connectionId={connectionId}
                                                                        entry={entry}
                                                                    />
                                                                    {isRenaming ? (
                                                                        <Input
                                                                            ref={renameField}
                                                                            value={renameValue}
                                                                            onChange={(e) =>
                                                                                setRenameValue(
                                                                                    e.target.value
                                                                                )
                                                                            }
                                                                            onKeyDown={(e) =>
                                                                                onRenameKey(
                                                                                    e,
                                                                                    entry
                                                                                )
                                                                            }
                                                                            onBlur={() =>
                                                                                submitRename(entry)
                                                                            }
                                                                            onClick={(e) =>
                                                                                e.stopPropagation()
                                                                            }
                                                                            className="h-7 w-full py-1 text-center text-xs"
                                                                        />
                                                                    ) : (
                                                                        <span className="w-full min-w-0 text-xs">
                                                                            <span
                                                                                className="inline-block max-w-full truncate align-bottom"
                                                                                title={entry.name}
                                                                            >
                                                                                {entry.name}
                                                                            </span>
                                                                        </span>
                                                                    )}
                                                                    <span
                                                                        className="text-[0.6875rem] text-muted-foreground"
                                                                        title={sizeTitle(entry)}
                                                                    >
                                                                        {entry.kind === "dir" &&
                                                                        !insights.sizes.has(
                                                                            entry.path
                                                                        )
                                                                            ? "Folder"
                                                                            : sizeLabel(entry)}
                                                                    </span>
                                                                    <div className="flex items-center gap-1">
                                                                        {entry.favorite ? (
                                                                            <Star className="size-3 fill-amber-400 text-amber-400" />
                                                                        ) : null}
                                                                        {entry.locked ? (
                                                                            <Lock className="size-3 text-muted-foreground" />
                                                                        ) : null}
                                                                        {insights.locked.has(
                                                                            entry.path
                                                                        ) ? (
                                                                            <KeyRound
                                                                                className="size-3 text-amber-400"
                                                                                aria-label="Needs a password"
                                                                            />
                                                                        ) : null}
                                                                        {entry.note ? (
                                                                            <StickyNote className="size-3 text-amber-500" />
                                                                        ) : null}
                                                                    </div>
                                                                </div>
                                                            </ContextMenuTrigger>
                                                            {entryMenu(entry)}
                                                        </ContextMenu>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ) : (
                                        <div
                                            ref={scrollRef}
                                            className="max-h-[65vh] overflow-auto"
                                            onMouseDown={onMarqueeDown}
                                        >
                                            <div
                                                style={{
                                                    height: `${rowVirtualizer.getTotalSize()}px`,
                                                    position: "relative",
                                                    width: "100%"
                                                }}
                                            >
                                                {marqueeRect ? (
                                                    <div
                                                        className="pointer-events-none absolute left-0 right-0 z-10 rounded-sm border border-primary/60 bg-primary/10"
                                                        style={{
                                                            top: `${marqueeRect.top}px`,
                                                            height: `${marqueeRect.height}px`
                                                        }}
                                                    />
                                                ) : null}
                                                {rowVirtualizer
                                                    .getVirtualItems()
                                                    .map((virtualRow) => {
                                                        const index = virtualRow.index;
                                                        const entry = visible[index];
                                                        if (!entry) return null;
                                                        const isSelected = selected.has(entry.path);
                                                        const isRenaming = renaming === entry.path;
                                                        return (
                                                            <ContextMenu key={entry.path}>
                                                                <ContextMenuTrigger asChild>
                                                                    <div
                                                                        data-drive-row
                                                                        style={{
                                                                            position: "absolute",
                                                                            top: 0,
                                                                            left: 0,
                                                                            width: "100%",
                                                                            height: `${virtualRow.size}px`,
                                                                            transform: `translateY(${virtualRow.start}px)`
                                                                        }}
                                                                        onClick={(event) =>
                                                                            rowClick(
                                                                                event,
                                                                                index,
                                                                                entry
                                                                            )
                                                                        }
                                                                        onContextMenu={() =>
                                                                            adoptForMenu(
                                                                                index,
                                                                                entry
                                                                            )
                                                                        }
                                                                        onDoubleClick={() => {
                                                                            if (!isRenaming)
                                                                                openEntry(entry);
                                                                        }}
                                                                        {...entryDragProps(
                                                                            entry,
                                                                            isRenaming
                                                                        )}
                                                                        className={cn(
                                                                            "flex h-10 items-center text-sm transition-colors",
                                                                            isSelected
                                                                                ? "bg-primary/5"
                                                                                : "hover:bg-card-hover",
                                                                            entry.hidden &&
                                                                                "opacity-50",
                                                                            cutPaths?.has(
                                                                                entry.path
                                                                            ) && "opacity-40",
                                                                            dropFolder ===
                                                                                entry.path &&
                                                                                "bg-primary/10 ring-2 ring-inset ring-primary"
                                                                        )}
                                                                    >
                                                                        <div className="flex w-9 shrink-0 items-center justify-center">
                                                                            <label
                                                                                className="flex cursor-pointer items-center"
                                                                                onClick={(e) =>
                                                                                    e.stopPropagation()
                                                                                }
                                                                            >
                                                                                <Checkbox
                                                                                    checked={
                                                                                        isSelected
                                                                                    }
                                                                                    onClick={(e) =>
                                                                                        handleSelectClick(
                                                                                            e,
                                                                                            index,
                                                                                            entry
                                                                                        )
                                                                                    }
                                                                                    onChange={() =>
                                                                                        undefined
                                                                                    }
                                                                                    aria-label={`Select ${entry.name}`}
                                                                                />
                                                                            </label>
                                                                        </div>
                                                                        <div className="min-w-0 flex-1 truncate px-1">
                                                                            {isRenaming ? (
                                                                                <Input
                                                                                    ref={
                                                                                        renameField
                                                                                    }
                                                                                    value={
                                                                                        renameValue
                                                                                    }
                                                                                    onChange={(e) =>
                                                                                        setRenameValue(
                                                                                            e.target
                                                                                                .value
                                                                                        )
                                                                                    }
                                                                                    onKeyDown={(
                                                                                        e
                                                                                    ) =>
                                                                                        onRenameKey(
                                                                                            e,
                                                                                            entry
                                                                                        )
                                                                                    }
                                                                                    onBlur={() =>
                                                                                        submitRename(
                                                                                            entry
                                                                                        )
                                                                                    }
                                                                                    onClick={(e) =>
                                                                                        e.stopPropagation()
                                                                                    }
                                                                                    size={Math.max(
                                                                                        renameValue.length +
                                                                                            1,
                                                                                        8
                                                                                    )}
                                                                                    className="h-7 !w-auto max-w-full py-1"
                                                                                />
                                                                            ) : entry.kind ===
                                                                              "dir" ? (
                                                                                <Link
                                                                                    href={href(
                                                                                        connectionId,
                                                                                        entry.path
                                                                                    )}
                                                                                    onClick={(e) =>
                                                                                        e.preventDefault()
                                                                                    }
                                                                                    className="flex items-center gap-2 hover:text-primary"
                                                                                >
                                                                                    <EntryIcon
                                                                                        entry={
                                                                                            entry
                                                                                        }
                                                                                    />
                                                                                    <span className="truncate">
                                                                                        {entry.name}
                                                                                    </span>
                                                                                    {searchScope ===
                                                                                        "recursive" &&
                                                                                    entry.path.includes(
                                                                                        "/"
                                                                                    ) ? (
                                                                                        <span className="shrink truncate text-xs text-muted-foreground">
                                                                                            in /
                                                                                            {parentOf(
                                                                                                entry.path
                                                                                            )}
                                                                                        </span>
                                                                                    ) : null}
                                                                                    {entry.favorite ? (
                                                                                        <Star
                                                                                            className="size-3 shrink-0 fill-amber-400 text-amber-400"
                                                                                            aria-label="Favorite"
                                                                                        />
                                                                                    ) : null}
                                                                                    {entry.locked ? (
                                                                                        <Lock
                                                                                            className="size-3 shrink-0 text-muted-foreground"
                                                                                            aria-label="Access-gated"
                                                                                        />
                                                                                    ) : null}
                                                                                    {entry.note ? (
                                                                                        <StickyNote
                                                                                            className="size-3 shrink-0 text-amber-500"
                                                                                            aria-label="Has a note"
                                                                                        />
                                                                                    ) : null}
                                                                                </Link>
                                                                            ) : (
                                                                                <a
                                                                                    href={downloadUrl(
                                                                                        connectionId,
                                                                                        entry.path
                                                                                    )}
                                                                                    onClick={(e) =>
                                                                                        e.preventDefault()
                                                                                    }
                                                                                    className="flex items-center gap-2 hover:text-primary"
                                                                                >
                                                                                    <EntryIcon
                                                                                        entry={
                                                                                            entry
                                                                                        }
                                                                                    />
                                                                                    <span className="truncate">
                                                                                        {entry.name}
                                                                                    </span>
                                                                                    {searchScope ===
                                                                                        "recursive" &&
                                                                                    entry.path.includes(
                                                                                        "/"
                                                                                    ) ? (
                                                                                        <span className="shrink truncate text-xs text-muted-foreground">
                                                                                            in /
                                                                                            {parentOf(
                                                                                                entry.path
                                                                                            )}
                                                                                        </span>
                                                                                    ) : null}
                                                                                    {entry.favorite ? (
                                                                                        <Star
                                                                                            className="size-3 shrink-0 fill-amber-400 text-amber-400"
                                                                                            aria-label="Favorite"
                                                                                        />
                                                                                    ) : null}
                                                                                    {insights.locked.has(
                                                                                        entry.path
                                                                                    ) ? (
                                                                                        <KeyRound
                                                                                            className="size-3 shrink-0 text-amber-400"
                                                                                            aria-label="Needs a password"
                                                                                        />
                                                                                    ) : null}
                                                                                    {entry.note ? (
                                                                                        <StickyNote
                                                                                            className="size-3 shrink-0 text-amber-500"
                                                                                            aria-label="Has a note"
                                                                                        />
                                                                                    ) : null}
                                                                                </a>
                                                                            )}
                                                                        </div>
                                                                        <div className="hidden w-44 shrink-0 truncate px-2 text-muted-foreground lg:block">
                                                                            <RelativeTime
                                                                                iso={
                                                                                    entry.createdAt
                                                                                }
                                                                            />
                                                                        </div>
                                                                        <div className="hidden w-44 shrink-0 truncate px-2 text-muted-foreground sm:block">
                                                                            <RelativeTime
                                                                                iso={
                                                                                    entry.modifiedAt
                                                                                }
                                                                            />
                                                                        </div>
                                                                        <div
                                                                            className="w-24 shrink-0 px-2 text-muted-foreground"
                                                                            title={sizeTitle(entry)}
                                                                        >
                                                                            {sizeLabel(entry)}
                                                                        </div>
                                                                        <div className="flex w-12 shrink-0 justify-end px-2">
                                                                            {onShare ? (
                                                                                <Button
                                                                                    size="icon"
                                                                                    variant="ghost"
                                                                                    onClick={(
                                                                                        event
                                                                                    ) => {
                                                                                        event.stopPropagation();
                                                                                        onShare(
                                                                                            menuTargets(
                                                                                                entry
                                                                                            )
                                                                                        );
                                                                                    }}
                                                                                    title={`Share ${entry.name}`}
                                                                                    aria-label={`Share ${entry.name}`}
                                                                                >
                                                                                    <Share2 className="size-4" />
                                                                                </Button>
                                                                            ) : null}
                                                                        </div>
                                                                    </div>
                                                                </ContextMenuTrigger>
                                                                {entryMenu(entry)}
                                                            </ContextMenu>
                                                        );
                                                    })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                            {dragUpload ? (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-primary/5 text-sm font-medium text-primary">
                                    Drop files to upload here
                                </div>
                            ) : null}
                        </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem onSelect={onNewFolder}>
                            <FolderPlus className="size-4" />
                            New folder
                            <MenuShortcut>{SHORTCUT_HINTS["new-folder"]}</MenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={onNewFile}>
                            <FilePlus className="size-4" />
                            New file
                            <MenuShortcut>{SHORTCUT_HINTS["new-file"]}</MenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => fileInput.current?.click()}>
                            <Upload className="size-4" />
                            Upload files
                            <MenuShortcut>{SHORTCUT_HINTS["upload-files"]}</MenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => void pickFolder()}>
                            <FolderUp className="size-4" />
                            Upload folder
                            <MenuShortcut>{SHORTCUT_HINTS["upload-folder"]}</MenuShortcut>
                        </ContextMenuItem>
                        {onSharePeopleFolder ? (
                            <ContextMenuItem onSelect={onSharePeopleFolder}>
                                <Users className="size-4" />
                                Share this folder with people
                            </ContextMenuItem>
                        ) : null}
                        {onShareFolder ? (
                            <ContextMenuItem onSelect={onShareFolder}>
                                <Share2 className="size-4" />
                                Get a link to this folder
                            </ContextMenuItem>
                        ) : null}
                        {onRequestFiles ? (
                            <ContextMenuItem
                                onSelect={() => onRequestFiles(path, path.split("/").pop() ?? "")}
                            >
                                <Inbox className="size-4" />
                                Request files here
                                <MenuShortcut>{SHORTCUT_HINTS["request-files"]}</MenuShortcut>
                            </ContextMenuItem>
                        ) : null}
                        {clipboard ? (
                            <ContextMenuItem onSelect={paste}>
                                <ClipboardPaste className="size-4" />
                                Paste
                                {clipboard.entries.length > 1
                                    ? ` (${clipboard.entries.length})`
                                    : ""}
                            </ContextMenuItem>
                        ) : null}
                    </ContextMenuContent>
                </ContextMenu>
            </div>
            {selectedEntries.length === 1 && selectedEntries[0] ? (
                <aside className="fixed right-0 top-14 bottom-0 z-30 hidden w-72 flex-col gap-4 overflow-auto border-l border-border bg-surface/40 p-4 lg:flex">
                    <div className="flex flex-col items-center gap-2 text-center">
                        <EntryIcon entry={selectedEntries[0]} className="size-10" />
                        <span className="break-all text-sm font-medium">
                            {selectedEntries[0].name}
                        </span>
                        {insights.locked.has(selectedEntries[0].path) ? (
                            <span className="flex items-center gap-1 text-xs text-amber-400">
                                <KeyRound className="size-3" />
                                Password-protected
                            </span>
                        ) : null}
                    </div>
                    <dl className="flex flex-col gap-2 text-xs">
                        <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Type</dt>
                            <dd className="truncate text-right">
                                {selectedEntries[0].kind === "dir"
                                    ? "Folder"
                                    : extensionOf(selectedEntries[0].name)
                                      ? `${extensionOf(selectedEntries[0].name).toUpperCase()} file`
                                      : "File"}
                            </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Size</dt>
                            <dd className="text-right" title={sizeTitle(selectedEntries[0])}>
                                {sizeLabel(selectedEntries[0])}
                            </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Owner</dt>
                            <dd className="truncate text-right">
                                {selectedEntries[0].owner ?? "Unknown"}
                            </dd>
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <dt className="text-muted-foreground">Location</dt>
                            <dd className="break-all">
                                /{selectedEntries[0].path.split("/").slice(0, -1).join("/")}
                            </dd>
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <dt className="text-muted-foreground">Created on</dt>
                            <dd>{format.dateTime(selectedEntries[0].createdAt)}</dd>
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <dt className="text-muted-foreground">Last Modified</dt>
                            <dd>{format.dateTime(selectedEntries[0].modifiedAt)}</dd>
                        </div>
                    </dl>
                    <div className="grid grid-cols-2 gap-2">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => selectedEntries[0] && openEntry(selectedEntries[0])}
                        >
                            Open
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => selectedEntries[0] && duplicate(selectedEntries[0])}
                        >
                            <Files className="size-4" />
                            Duplicate
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => selectedEntries[0] && openMove([selectedEntries[0]])}
                        >
                            <FolderInput className="size-4" />
                            Move
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                                selectedEntries[0] &&
                                void navigator.clipboard.writeText(selectedEntries[0].path)
                            }
                        >
                            <ClipboardCopy className="size-4" />
                            Copy path
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                                selectedEntries[0] &&
                                onSetFavorite(selectedEntries[0], !selectedEntries[0].favorite)
                            }
                        >
                            <Star
                                className={cn(
                                    "size-4",
                                    selectedEntries[0].favorite && "fill-amber-400 text-amber-400"
                                )}
                            />
                            {selectedEntries[0].favorite ? "Starred" : "Star"}
                        </Button>
                    </div>
                    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                        <span className="text-xs font-medium text-muted-foreground">Activity</span>
                        {activityLoading ? (
                            <p className="text-xs text-muted-foreground/60">Loading...</p>
                        ) : activity.length === 0 ? (
                            <p className="text-xs text-muted-foreground/60">
                                No recorded activity yet.
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-1.5">
                                {activity.map((item) => {
                                    const Icon = activityIcon(item.action);
                                    return (
                                        <li
                                            key={item.id}
                                            className="flex items-start gap-2 text-xs"
                                        >
                                            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                                                <Icon className="size-3" />
                                            </span>
                                            <div className="flex min-w-0 flex-col">
                                                <span>
                                                    {activityLabel(item.action)}
                                                    {item.actor ? " by " : ""}
                                                    {item.actor ? (
                                                        item.actorId ? (
                                                            <button
                                                                type="button"
                                                                onClick={() =>
                                                                    setProfileUserId(item.actorId)
                                                                }
                                                                className="font-medium text-primary hover:underline"
                                                            >
                                                                {item.actor}
                                                            </button>
                                                        ) : (
                                                            <span className="font-medium">
                                                                {item.actor}
                                                            </span>
                                                        )
                                                    ) : null}
                                                </span>
                                                <span className="text-muted-foreground/70">
                                                    <RelativeTime iso={item.at} />
                                                </span>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                    <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">Note</span>
                            <button
                                type="button"
                                onClick={() => selectedEntries[0] && openNote(selectedEntries[0])}
                                className="text-xs text-primary hover:underline"
                            >
                                {selectedEntries[0].note ? "Edit" : "Add"}
                            </button>
                        </div>
                        {selectedEntries[0].note ? (
                            <p className="whitespace-pre-line text-xs text-muted-foreground">
                                {selectedEntries[0].note}
                            </p>
                        ) : (
                            <p className="text-xs text-muted-foreground/60">No note</p>
                        )}
                    </div>
                </aside>
            ) : null}

            <UserProfileDialog
                userId={profileUserId}
                onOpenChange={(open) => !open && setProfileUserId(null)}
            />

            <ArchiveDialog
                key={archiveTarget?.path ?? "none"}
                connectionId={connectionId}
                target={archiveTarget}
                currentPath={path}
                onOpenChange={(open) => !open && setArchiveTarget(null)}
            />

            <Dialog
                open={pendingFolder !== null}
                onOpenChange={(open) => !open && setPendingFolder(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Upload folder</DialogTitle>
                        <DialogDescription className="truncate">
                            {pendingFolder
                                ? `Upload ${pendingFolder.items.length} file${
                                      pendingFolder.items.length === 1 ? "" : "s"
                                  } (${formatBytes(
                                      pendingFolder.items.reduce(
                                          (sum, item) => sum + BigInt(item.file.size),
                                          0n
                                      )
                                  )}) from "${pendingFolder.name}"?`
                                : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setPendingFolder(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            onClick={() => {
                                if (pendingFolder) onUpload(pendingFolder.items);
                                setPendingFolder(null);
                            }}
                        >
                            <Upload className="size-4" />
                            Upload
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog
                open={iconTargets !== null}
                onOpenChange={(open) => !open && setIconTargets(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Change icon</DialogTitle>
                        <DialogDescription className="truncate">
                            {iconTargets && iconTargets.length > 1
                                ? `${iconTargets.length} items`
                                : iconPreview?.name}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4">
                        <div className="grid grid-cols-7 gap-1.5">
                            {Object.entries(ITEM_ICONS).map(([name, Icon]) => (
                                <button
                                    key={name}
                                    type="button"
                                    onClick={() =>
                                        applyIcon(name, iconPreview?.iconColor ?? "primary")
                                    }
                                    className={cn(
                                        "flex items-center justify-center rounded-md border p-2 transition-colors hover:bg-muted",
                                        iconPreview?.icon === name
                                            ? "border-primary"
                                            : "border-border"
                                    )}
                                >
                                    <Icon
                                        className={cn(
                                            "size-5",
                                            iconColorClass(iconPreview?.iconColor)
                                        )}
                                    />
                                </button>
                            ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {ITEM_ICON_COLORS.map((color) => (
                                <button
                                    key={color.id}
                                    type="button"
                                    aria-label={color.id}
                                    onClick={() =>
                                        applyIcon(iconPreview?.icon ?? "folder", color.id)
                                    }
                                    className={cn(
                                        "size-6 rounded-full ring-offset-2 transition",
                                        iconPreview?.iconColor === color.id
                                            ? "ring-2 ring-primary"
                                            : ""
                                    )}
                                >
                                    <span
                                        className={cn("block size-full rounded-full", color.swatch)}
                                    />
                                </button>
                            ))}
                        </div>
                        <div className="flex justify-between">
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    for (const item of iconTargets ?? []) {
                                        onSetIcon(item, null, null);
                                    }
                                    setIconTargets(null);
                                }}
                            >
                                Reset to default
                            </Button>
                            <Button type="button" size="sm" onClick={() => setIconTargets(null)}>
                                Done
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog
                open={detailsTarget !== null}
                onOpenChange={(open) => !open && setDetailsTarget(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Details</DialogTitle>
                    </DialogHeader>
                    {detailsTarget ? (
                        <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
                            <dt className="text-muted-foreground">Name</dt>
                            <dd className="truncate">{detailsTarget.name}</dd>
                            <dt className="text-muted-foreground">Type</dt>
                            <dd>
                                {detailsTarget.kind === "dir"
                                    ? "Folder"
                                    : extensionOf(detailsTarget.name)
                                      ? `${extensionOf(detailsTarget.name).toUpperCase()} file`
                                      : "File"}
                            </dd>
                            <dt className="text-muted-foreground">Location</dt>
                            <dd className="truncate">
                                /{detailsTarget.path.split("/").slice(0, -1).join("/")}
                            </dd>
                            <dt className="text-muted-foreground">Size</dt>
                            <dd title={sizeTitle(detailsTarget)}>
                                {detailsTarget.kind === "dir"
                                    ? sizeLabel(detailsTarget)
                                    : `${formatBytes(BigInt(detailsTarget.size))} (${Number(detailsTarget.size).toLocaleString()} bytes)`}
                            </dd>
                            <dt className="text-muted-foreground">Modified</dt>
                            <dd>{format.dateTime(detailsTarget.modifiedAt)}</dd>
                        </dl>
                    ) : null}
                </DialogContent>
            </Dialog>

            <Dialog
                open={noteTarget !== null}
                onOpenChange={(open) => !open && setNoteTarget(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Note</DialogTitle>
                        <DialogDescription className="truncate">
                            {noteTarget?.name}
                        </DialogDescription>
                    </DialogHeader>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (noteTarget) onSetNote(noteTarget, noteValue.trim() || null);
                            setNoteTarget(null);
                        }}
                        className="flex flex-col gap-3"
                    >
                        <Textarea
                            autoFocus
                            value={noteValue}
                            onChange={(event) => setNoteValue(event.target.value)}
                            rows={4}
                            placeholder="Add a note for this item..."
                            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
                        />
                        <div className="flex justify-between">
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    if (noteTarget) onSetNote(noteTarget, null);
                                    setNoteTarget(null);
                                }}
                            >
                                Remove
                            </Button>
                            <Button type="submit" size="sm">
                                Save
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog
                open={moveTargets !== null}
                onOpenChange={(open) => !open && setMoveTargets(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            Move{" "}
                            {moveTargets && moveTargets.length > 1
                                ? `${moveTargets.length} items`
                                : "item"}
                        </DialogTitle>
                        <DialogDescription>
                            Pick the destination folder, or type its path.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={submitMove} className="flex flex-col gap-3">
                        <FolderTree
                            connectionId={connectionId}
                            value={normalizedMoveDest}
                            onChange={setMoveDest}
                            root={rootPath}
                            className="max-h-72"
                        />
                        <Input
                            value={moveDest}
                            onChange={(event) => setMoveDest(event.target.value)}
                            placeholder="e.g. Documents/Archive"
                        />
                        {moveError ? (
                            <p className="text-xs text-muted-foreground">{moveError}</p>
                        ) : null}
                        <div className="flex justify-end gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => setMoveTargets(null)}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={moveError !== null}>
                                Move
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** The icon for an entry: a user-set one, else the folder mark or the file type's. */
/**
 * A tile's picture, or its icon.
 *
 * Only a file whose name could produce one is wrapped at all, so a folder or a
 * spreadsheet costs nothing to decide - not a request, not an observer, not an
 * element. The size is fixed either way so the grid does not reflow when a
 * picture arrives after the icon.
 */
function GridIcon({ connectionId, entry }: { connectionId: string; entry: DriveEntry }) {
    const icon = <EntryIcon entry={entry} className="size-10" />;
    if (entry.kind !== "file" || !thumbnailKind(entry.name)) return icon;
    return (
        <EntryThumbnail
            connectionId={connectionId}
            path={entry.path}
            version={`${entry.modifiedAt}-${entry.size}`}
            className="size-14"
        >
            {icon}
        </EntryThumbnail>
    );
}

function EntryIcon({ entry, className = "size-4" }: { entry: DriveEntry; className?: string }) {
    const Custom = iconComponent(entry.icon);
    if (Custom) return <Custom className={cn(className, iconColorClass(entry.iconColor))} />;
    if (entry.kind === "dir") return <Folder className={cn(className, "text-primary")} />;
    const { icon: Icon, className: color } = fileIconFor(entry.name);
    return <Icon className={cn(className, color)} />;
}

/**
 * Replace the drag ghost with the number of items being carried. The browser
 * draws only the row under the pointer, which reads as though the rest of the
 * selection stayed behind - and the whole selection is what moves.
 */
function showCountDragImage(event: React.DragEvent, count: number) {
    const ghost = document.createElement("div");
    ghost.textContent = `${count} items`;
    ghost.style.cssText = `position:fixed;top:-1000px;left:-1000px;padding:4px 10px;border-radius:6px;
        font:500 12px/1.4 system-ui,sans-serif;white-space:nowrap;
        background:hsl(var(--primary));color:hsl(var(--primary-foreground))`;
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 12, 12);
    // The image is snapshotted synchronously, so the node is only needed for this frame.
    requestAnimationFrame(() => ghost.remove());
}

/** Minimal File System Access API shapes (avoids depending on lib.dom having them). */
interface FsFileHandle {
    kind: "file";
    name: string;
    getFile(): Promise<File>;
}
interface FsDirectoryHandle {
    kind: "directory";
    name: string;
    values(): AsyncIterable<FsFileHandle | FsDirectoryHandle>;
}

/**
 * Read every file under a File System Access directory handle, with folder-relative
 * paths ("folder/sub/file.txt"). Used for the folder upload so we can confirm in an
 * in-app dialog instead of the browser's own "Upload N files?" prompt (which the
 * legacy <input webkitdirectory> path forces and cannot be styled away).
 */
async function readDirectoryHandle(dir: FsDirectoryHandle, prefix: string): Promise<UploadItem[]> {
    const out: UploadItem[] = [];
    for await (const handle of dir.values()) {
        const rel = `${prefix}${handle.name}`;
        if (handle.kind === "file") out.push({ file: await handle.getFile(), relPath: rel });
        else out.push(...(await readDirectoryHandle(handle, `${rel}/`)));
    }
    return out;
}

/**
 * Placeholder while a directory listing loads, in the shape the view is set to:
 * a grid of tiles reads nothing like a table of rows, so a listing that is about
 * to arrive as one must not be sketched as the other.
 */
function ListingSkeleton({ viewMode }: { viewMode: "list" | "grid" }) {
    if (viewMode === "grid") {
        return (
            <div className="grid grid-cols-2 gap-2 p-1 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                {Array.from({ length: 12 }).map((_, index) => (
                    <div key={index} className="flex flex-col items-center gap-1.5 p-3">
                        <Skeleton className="size-10 rounded" />
                        <Skeleton className="h-3 w-4/5" />
                    </div>
                ))}
            </div>
        );
    }
    return (
        <div className="flex flex-col">
            {/* The column widths track the real header and rows below, so the
                listing lands on the same grid it was sketched on. */}
            <div className="flex h-9 items-center border-b border-border">
                <div className="w-9 shrink-0" />
                <div className="min-w-0 flex-1 px-1">
                    <Skeleton className="h-3 w-12" />
                </div>
                <div className="hidden w-44 shrink-0 px-2 lg:block">
                    <Skeleton className="h-3 w-20" />
                </div>
                <div className="hidden w-44 shrink-0 px-2 sm:block">
                    <Skeleton className="h-3 w-24" />
                </div>
                <div className="w-24 shrink-0 px-2">
                    <Skeleton className="h-3 w-8" />
                </div>
                <div className="w-12 shrink-0" />
            </div>
            {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="flex h-10 items-center">
                    <div className="flex w-9 shrink-0 items-center justify-center">
                        <Skeleton className="size-4 rounded" />
                    </div>
                    <div className="min-w-0 flex-1 px-1">
                        <Skeleton className="h-4 w-1/3" />
                    </div>
                    <div className="hidden w-44 shrink-0 px-2 lg:block">
                        <Skeleton className="h-3 w-28" />
                    </div>
                    <div className="hidden w-44 shrink-0 px-2 sm:block">
                        <Skeleton className="h-3 w-28" />
                    </div>
                    <div className="w-24 shrink-0 px-2">
                        <Skeleton className="h-3 w-12" />
                    </div>
                    <div className="w-12 shrink-0" />
                </div>
            ))}
        </div>
    );
}
