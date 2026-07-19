"use client";

/**
 * The file table for one location: breadcrumb, a search/sort/filter toolbar, and
 * a selectable list. Rows support fuzzy search (fuse.js), category/size/date
 * filters, multi-select (ctrl toggles, shift extends a range), inline rename
 * (double-click the name), a right-click context menu, and bulk download/delete.
 * All of this is client-side over the already-fetched listing, so it stays fast
 * and does not re-hit the NAS on every keystroke.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import Fuse from "fuse.js";
import {
    ArrowDownAZ,
    ArrowUpAZ,
    ChevronRight,
    ClipboardCopy,
    ClipboardPaste,
    Copy,
    Download,
    Eye,
    EyeOff,
    File,
    FilePlus,
    Files,
    Folder,
    FolderInput,
    FolderPlus,
    FolderTree,
    FolderUp,
    Inbox,
    Info,
    Lock,
    Palette,
    Pencil,
    Scissors,
    Search,
    Share2,
    ShieldCheck,
    SlidersHorizontal,
    Star,
    StarOff,
    StickyNote,
    Trash2,
    Upload,
    X
} from "lucide-react";
import { formatBytes } from "@polaris/core";
import {
    Badge,
    Button,
    Checkbox,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    Skeleton,
    cn
} from "@polaris/ui";
import { FILE_CATEGORIES, categoryOfExtension, extensionOf, type FileCategory } from "./file-categories";
import { FileViewer, isViewable, type ViewerTarget } from "./file-viewer";
import { ITEM_ICONS, ITEM_ICON_COLORS, iconColorClass, iconComponent } from "./item-icons";
import { matchesStructured, parseSearch } from "./search-query";
import { RelativeTime } from "@/components/relative-time";
import type { DriveEntry } from "./types";

type SortKey = "name" | "created" | "modified" | "size";
type SortDir = "asc" | "desc";

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

/**
 * Download several items (files and/or folders) as one ZIP. A form POST is used
 * rather than many anchor clicks - browsers throttle/deny rapid successive
 * downloads, which is why multi-select "Download" was unreliable, and a folder
 * has no single-file form at all. The attachment response streams to disk while
 * the page stays put.
 */
function downloadZip(connectionId: string, paths: string[]) {
    if (paths.length === 0) return;
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/drive/download-zip";
    const connectionField = document.createElement("input");
    connectionField.type = "hidden";
    connectionField.name = "c";
    connectionField.value = connectionId;
    form.appendChild(connectionField);
    for (const path of paths) {
        const field = document.createElement("input");
        field.type = "hidden";
        field.name = "p";
        field.value = path;
        form.appendChild(field);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
}

/**
 * Download a selection the smartest way: a single file streams directly (fast,
 * resumable, Range-friendly); anything else - multiple items or any folder - is
 * bundled into one ZIP.
 */
function downloadSelection(connectionId: string, entries: DriveEntry[]) {
    if (entries.length === 1 && entries[0] && entries[0].kind === "file") {
        triggerDownload(connectionId, entries[0]);
        return;
    }
    downloadZip(
        connectionId,
        entries.map((entry) => entry.path)
    );
}

export function FilesView({
    connectionId,
    path,
    segments,
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
    onRequestFiles,
    onToggleHidden,
    onToggleFavorite,
    onSetIcon,
    onSetNote,
    onMove,
    onCopy,
    onManageAccess
}: {
    connectionId: string;
    path: string;
    segments: string[];
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
    onShare: (entry: DriveEntry) => void;
    onRequestFiles: (path: string, name: string) => void;
    onToggleHidden: (entry: DriveEntry) => void;
    onToggleFavorite: (entry: DriveEntry) => void;
    onSetIcon: (entry: DriveEntry, icon: string | null, color: string | null) => void;
    onSetNote: (entry: DriveEntry, note: string | null) => void;
    onMove: (entry: DriveEntry, destFolderPath: string) => void;
    onCopy: (entry: DriveEntry, destFolderPath: string) => void;
    /** Manage per-path access (ACL grants and the password lock). Owner/admin only. */
    onManageAccess?: (entry: DriveEntry) => void;
}) {
    const [query, setQuery] = useState("");
    // Search scope: the current folder only, or a recursive walk from here.
    const [searchScope, setSearchScope] = useState<"current" | "recursive">("current");
    const [remoteEntries, setRemoteEntries] = useState<DriveEntry[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchTruncated, setSearchTruncated] = useState(false);
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [categories, setCategories] = useState<Set<FileCategory>>(new Set());
    const [extFilter, setExtFilter] = useState("");
    const [minMb, setMinMb] = useState("");
    const [maxMb, setMaxMb] = useState("");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");

    const [selected, setSelected] = useState<Set<string>>(new Set());
    const lastIndex = useRef<number | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [viewerTarget, setViewerTarget] = useState<ViewerTarget | null>(null);
    const [showHidden, setShowHidden] = useState(false);
    const [starredOnly, setStarredOnly] = useState(false);
    const [iconTarget, setIconTarget] = useState<DriveEntry | null>(null);
    const [detailsTarget, setDetailsTarget] = useState<DriveEntry | null>(null);
    const [noteTarget, setNoteTarget] = useState<DriveEntry | null>(null);
    const [noteValue, setNoteValue] = useState("");
    const [moveTargets, setMoveTargets] = useState<DriveEntry[] | null>(null);
    const [moveDest, setMoveDest] = useState("");

    function openNote(entry: DriveEntry) {
        setNoteTarget(entry);
        setNoteValue(entry.note ?? "");
    }

    /** Parent folder path of a relative path ("a/b/c" -> "a/b"). */
    function parentOf(target: string): string {
        const slash = target.lastIndexOf("/");
        return slash >= 0 ? target.slice(0, slash) : "";
    }

    /** Copy an item into its own folder (a duplicate gets a " copy" suffix). */
    function duplicate(entry: DriveEntry) {
        onCopy(entry, parentOf(entry.path));
    }

    function openMove(entries: DriveEntry[]) {
        setMoveTargets(entries);
        setMoveDest(path);
    }

    function submitMove(event: React.FormEvent) {
        event.preventDefault();
        if (!moveTargets) return;
        const dest = moveDest.trim().replace(/^\/+|\/+$/g, "");
        for (const entry of moveTargets) onMove(entry, dest);
        setMoveTargets(null);
    }
    const [dragUpload, setDragUpload] = useState(false);
    const [clipboard, setClipboard] = useState<{ entries: DriveEntry[]; mode: "copy" | "cut" } | null>(null);
    const dragPath = useRef<string | null>(null);
    const folderInput = useRef<HTMLInputElement>(null);
    const router = useRouter();

    /** Paste the clipboard into the current folder: copy duplicates, cut moves. */
    function paste() {
        if (!clipboard) return;
        for (const entry of clipboard.entries) {
            if (clipboard.mode === "cut") onMove(entry, path);
            else onCopy(entry, path);
        }
        if (clipboard.mode === "cut") setClipboard(null);
    }

    function openViewer(entry: DriveEntry) {
        setViewerTarget({
            connectionId,
            path: entry.path,
            name: entry.name,
            size: entry.size,
            modifiedAt: entry.modifiedAt
        });
    }

    /** Open an item: folders navigate, files preview (or download when no viewer). */
    function openEntry(entry: DriveEntry) {
        if (entry.kind === "dir") router.push(href(connectionId, entry.path));
        else if (isViewable(entry.name)) openViewer(entry);
        else triggerDownload(connectionId, entry);
    }

    /** Windows-style row click: plain selects only this, ctrl toggles, shift extends. */
    function rowClick(event: MouseEvent, index: number, entry: DriveEntry) {
        if (renaming === entry.path) return;
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

    /** Double-clicking the name (specifically) renames; elsewhere on the row opens. */
    function nameDoubleClick(event: MouseEvent, entry: DriveEntry) {
        event.preventDefault();
        event.stopPropagation();
        startRename(entry);
    }

    /** Keyboard: F2 renames, Enter opens, Delete removes, Ctrl+C/X/V copy/cut/paste. */
    function onListKeyDown(event: KeyboardEvent) {
        if (renaming) return;
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (mod && key === "c" && selectedEntries.length > 0) {
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

    /** Drop a dragged row onto a folder to move it there (never into itself). */
    function onFolderDrop(event: React.DragEvent, folder: DriveEntry) {
        const source = dragPath.current ?? event.dataTransfer.getData("application/x-polaris-path");
        dragPath.current = null;
        if (!source || source === folder.path || folder.path.startsWith(`${source}/`)) return;
        event.preventDefault();
        event.stopPropagation();
        const dragged = entries.find((entry) => entry.path === source);
        if (dragged) onMove(dragged, folder.path);
    }

    // Selection and rename are tied to a specific listing; drop them whenever the
    // location changes so a stale selection never leaks across folders.
    useEffect(() => {
        setSelected(new Set());
        setRenaming(null);
        lastIndex.current = null;
    }, [connectionId, path]);

    // A path query ("docs/report.pdf", "c:/users/me/...") matches on full paths and
    // only makes sense as a recursive walk, so it forces recursive scope regardless
    // of the toggle.
    const isPathQuery = useMemo(() => parseSearch(query).pathMatcher !== undefined, [query]);
    const effectiveScope: "current" | "recursive" = isPathQuery ? "recursive" : searchScope;

    // Recursive search: when the scope is "recursive" and there is a query, walk
    // the subtree server-side (debounced) instead of filtering the local listing.
    useEffect(() => {
        if (effectiveScope !== "recursive" || !query.trim()) {
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
                    setRemoteEntries(Array.isArray(body.entries) ? (body.entries as DriveEntry[]) : []);
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
    }, [effectiveScope, query, connectionId, path]);

    // The rows the pipeline operates on: recursive results when searching a
    // subtree, otherwise the current folder's listing.
    const source = effectiveScope === "recursive" && remoteEntries !== null ? remoteEntries : entries;

    const hasFilters =
        categories.size > 0 || extFilter.trim() !== "" || minMb !== "" || maxMb !== "" || dateFrom !== "" || dateTo !== "";

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
        if (parsed.pathMatcher) {
            // Path query: match on the full relative path, no name fuzzy pass.
            const matcher = parsed.pathMatcher;
            rows = rows.filter((entry) => matcher(entry.path));
        } else {
            rows = rows.filter((entry) => matchesStructured(entry.name, parsed));
            if (parsed.fuzzy) {
                const fuse = new Fuse(rows, { keys: ["name"], threshold: 0.4, ignoreLocation: true });
                rows = fuse.search(parsed.fuzzy).map((result) => result.item);
            }
        }

        const direction = sortDir === "asc" ? 1 : -1;
        // Folders group above files; the chosen key orders within each group.
        return [...rows].sort((a, b) => {
            const dirA = a.kind === "dir" ? 0 : 1;
            const dirB = b.kind === "dir" ? 0 : 1;
            if (dirA !== dirB) return dirA - dirB;
            if (sortKey === "size") return (Number(a.size) - Number(b.size)) * direction;
            if (sortKey === "created") {
                return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * direction;
            }
            if (sortKey === "modified") {
                return (new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()) * direction;
            }
            return a.name.localeCompare(b.name) * direction;
        });
    }, [source, categories, extFilter, minMb, maxMb, dateFrom, dateTo, query, sortKey, sortDir, showHidden, starredOnly]);

    const selectedEntries = visible.filter((entry) => selected.has(entry.path));
    const allSelected = visible.length > 0 && selectedEntries.length === visible.length;
    const searchError = useMemo(() => parseSearch(query).error, [query]);

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
                    {clipboard ? (
                        <Button size="sm" variant="ghost" onClick={paste} disabled={pending}>
                            <ClipboardPaste className="size-4" />
                            Paste ({clipboard.entries.length})
                        </Button>
                    ) : null}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRequestFiles(path, segments[segments.length - 1] ?? "")}
                        disabled={pending}
                    >
                        <Inbox className="size-4" />
                        Request files
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onNewFolder} disabled={pending}>
                        <FolderPlus className="size-4" />
                        New folder
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="secondary" disabled={uploading}>
                                <Upload className="size-4" />
                                {uploading ? "Uploading..." : "Upload"}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                                <Upload className="size-4" />
                                Files
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => folderInput.current?.click()}>
                                <FolderUp className="size-4" />
                                Folder
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
                        placeholder="Search - try *.pdf, ext:pptx,pdf, docs/report.pdf, /regex/"
                        title="Wildcards (*, ?), ext:pptx,pdf for extensions, a path like docs/report.pdf, /pattern/ for regex, or plain text for a fuzzy match"
                        className={cn("pl-8 pr-9", searchError && "border-danger")}
                    />
                    <button
                        type="button"
                        onClick={() => setSearchScope((prev) => (prev === "current" ? "recursive" : "current"))}
                        aria-label="Toggle search scope"
                        disabled={isPathQuery}
                        title={
                            isPathQuery
                                ? "Path search always walks this folder and all subfolders."
                                : effectiveScope === "recursive"
                                  ? "Searching this folder and all subfolders. Click to search only this folder."
                                  : "Searching only this folder. Click to search all subfolders too."
                        }
                        className={cn(
                            "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition-colors hover:bg-muted disabled:cursor-not-allowed",
                            effectiveScope === "recursive" ? "text-primary" : "text-muted-foreground"
                        )}
                    >
                        {effectiveScope === "recursive" ? (
                            <FolderTree className="size-4" />
                        ) : (
                            <Folder className="size-4" />
                        )}
                    </button>
                </div>
                <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                    {(["name", "created", "modified", "size"] as const).map((key) => (
                        <button
                            key={key}
                            type="button"
                            onClick={() => setSortKey(key)}
                            className={cn(
                                "rounded px-2 py-1 text-xs capitalize transition-colors hover:bg-muted",
                                sortKey === key && "bg-muted font-medium"
                            )}
                        >
                            {key}
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={() => setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
                        aria-label={`Sort ${sortDir === "asc" ? "descending" : "ascending"}`}
                    >
                        {sortDir === "asc" ? <ArrowDownAZ className="size-4" /> : <ArrowUpAZ className="size-4" />}
                    </button>
                </div>
                <Button
                    size="sm"
                    variant={hasFilters ? "secondary" : "ghost"}
                    onClick={() => setFiltersOpen((prev) => !prev)}
                >
                    <SlidersHorizontal className="size-4" />
                    Filters
                    {hasFilters ? <Badge variant="neutral">{categories.size + (extFilter ? 1 : 0)}</Badge> : null}
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
                <Button
                    size="sm"
                    variant={starredOnly ? "secondary" : "ghost"}
                    onClick={() => setStarredOnly((prev) => !prev)}
                    aria-label={starredOnly ? "Show all items" : "Show starred only"}
                >
                    <Star className={cn("size-4", starredOnly && "fill-amber-400 text-amber-400")} />
                    Starred
                </Button>
            </div>

            {effectiveScope === "recursive" && query.trim() ? (
                <p className="mb-3 -mt-1 text-xs text-muted-foreground">
                    {searching
                        ? "Searching this folder and all subfolders..."
                        : `${visible.length} result${visible.length === 1 ? "" : "s"} across subfolders${
                              searchTruncated ? " (first matches only - narrow your search)" : ""
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
                            <Input value={extFilter} onChange={(e) => setExtFilter(e.target.value)} placeholder="pdf" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Min size (MB)
                            <Input value={minMb} onChange={(e) => setMinMb(e.target.value)} type="number" min="0" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Max size (MB)
                            <Input value={maxMb} onChange={(e) => setMaxMb(e.target.value)} type="number" min="0" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Modified after
                            <Input value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} type="date" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Modified before
                            <Input value={dateTo} onChange={(e) => setDateTo(e.target.value)} type="date" />
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

            {selectedEntries.length > 0 ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
                    <span className="font-medium">{selectedEntries.length} selected</span>
                    <div className="ml-auto flex items-center gap-1">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => downloadSelection(connectionId, selectedEntries)}
                        >
                            <Download className="size-4" />
                            Download
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onDelete(selectedEntries)} disabled={pending}>
                            <Trash2 className="size-4" />
                            Delete
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                            <X className="size-4" />
                            Clear
                        </Button>
                    </div>
                </div>
            ) : null}

            <div className="flex items-start gap-4">
            <ContextMenu>
            <ContextMenuTrigger asChild>
            <div
                tabIndex={0}
                onKeyDown={onListKeyDown}
                className={cn(
                    "relative min-w-0 flex-1 rounded-lg focus:outline-none",
                    dragUpload && "ring-2 ring-primary ring-offset-2 ring-offset-background"
                )}
                onDragOver={onUploadDragOver}
                onDragLeave={() => setDragUpload(false)}
                onDrop={onUploadDrop}
            >
            {loading ? (
                <ListingSkeleton />
            ) : error ? (
                <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
            ) : (
                <div>
                    <div className="flex h-9 items-center border-b border-border text-left text-xs font-medium text-muted-foreground">
                        <div className="flex w-9 shrink-0 items-center justify-center">
                            <label className="flex cursor-pointer items-center">
                                <Checkbox
                                    checked={allSelected}
                                    indeterminate={!allSelected && selectedEntries.length > 0}
                                    onChange={toggleAll}
                                    aria-label="Select all"
                                />
                            </label>
                        </div>
                        <div className="min-w-0 flex-1 px-1">Name</div>
                        <div className="hidden w-44 shrink-0 px-2 lg:block">Created on</div>
                        <div className="hidden w-44 shrink-0 px-2 sm:block">Last Modified</div>
                        <div className="w-24 shrink-0 px-2">Size</div>
                        <div className="w-12 shrink-0 px-2" />
                    </div>
                    {visible.length === 0 ? (
                        <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                            {effectiveScope === "recursive" && query.trim()
                                ? searching
                                    ? "Searching..."
                                    : "No matches in this folder or its subfolders."
                                : source.length === 0
                                  ? "This folder is empty."
                                  : "Nothing matches your search or filters."}
                        </p>
                    ) : (
                        <div ref={scrollRef} className="max-h-[65vh] overflow-auto" onMouseDown={onMarqueeDown}>
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
                                        style={{ top: `${marqueeRect.top}px`, height: `${marqueeRect.height}px` }}
                                    />
                                ) : null}
                                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
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
                                                    onClick={(event) => rowClick(event, index, entry)}
                                                    onDoubleClick={() => {
                                                        if (!isRenaming) openEntry(entry);
                                                    }}
                                                    draggable={!isRenaming}
                                                    onDragStart={(event) => {
                                                        dragPath.current = entry.path;
                                                        event.dataTransfer.setData(
                                                            "application/x-polaris-path",
                                                            entry.path
                                                        );
                                                        event.dataTransfer.effectAllowed = "move";
                                                    }}
                                                    onDragEnd={() => {
                                                        dragPath.current = null;
                                                    }}
                                                    onDragOver={
                                                        entry.kind === "dir"
                                                            ? (event) => {
                                                                  if (
                                                                      dragPath.current &&
                                                                      dragPath.current !== entry.path
                                                                  )
                                                                      event.preventDefault();
                                                              }
                                                            : undefined
                                                    }
                                                    onDrop={
                                                        entry.kind === "dir"
                                                            ? (event) => onFolderDrop(event, entry)
                                                            : undefined
                                                    }
                                                    className={cn(
                                                        "flex h-10 items-center text-sm transition-colors",
                                                        isSelected ? "bg-primary/5" : "hover:bg-card-hover",
                                                        entry.hidden && "opacity-50"
                                                    )}
                                                >
                                                    <div className="flex w-9 shrink-0 items-center justify-center">
                                                        <label
                                                            className="flex cursor-pointer items-center"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <Checkbox
                                                                checked={isSelected}
                                                                onClick={(e) => handleSelectClick(e, index, entry)}
                                                                onChange={() => undefined}
                                                                aria-label={`Select ${entry.name}`}
                                                            />
                                                        </label>
                                                    </div>
                                                    <div className="min-w-0 flex-1 truncate px-1">
                                                        {isRenaming ? (
                                                            <Input
                                                                autoFocus
                                                                value={renameValue}
                                                                onChange={(e) => setRenameValue(e.target.value)}
                                                                onKeyDown={(e) => onRenameKey(e, entry)}
                                                                onBlur={() => submitRename(entry)}
                                                                className="h-7 py-1"
                                                            />
                                                        ) : entry.kind === "dir" ? (
                                                            <Link
                                                                href={href(connectionId, entry.path)}
                                                                onClick={(e) => e.preventDefault()}
                                                                onDoubleClick={(e) => nameDoubleClick(e, entry)}
                                                                className="flex items-center gap-2 hover:text-primary"
                                                            >
                                                                <EntryIcon entry={entry} />
                                                                {entry.name}
                                                                {effectiveScope === "recursive" && entry.path.includes("/") ? (
                                                                    <span className="shrink truncate text-xs text-muted-foreground">
                                                                        in /{parentOf(entry.path)}
                                                                    </span>
                                                                ) : null}
                                                                {entry.locked ? (
                                                                    <Lock
                                                                        className="size-3 shrink-0 text-muted-foreground"
                                                                        aria-label="Access-gated"
                                                                    />
                                                                ) : null}
                                                                {entry.favorite ? (
                                                                    <Star
                                                                        className="size-3 shrink-0 fill-amber-400 text-amber-400"
                                                                        aria-label="Starred"
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
                                                                href={downloadUrl(connectionId, entry.path)}
                                                                onClick={(e) => e.preventDefault()}
                                                                onDoubleClick={(e) => nameDoubleClick(e, entry)}
                                                                className="flex items-center gap-2 hover:text-primary"
                                                            >
                                                                <EntryIcon entry={entry} />
                                                                {entry.name}
                                                                {effectiveScope === "recursive" && entry.path.includes("/") ? (
                                                                    <span className="shrink truncate text-xs text-muted-foreground">
                                                                        in /{parentOf(entry.path)}
                                                                    </span>
                                                                ) : null}
                                                                {entry.favorite ? (
                                                                    <Star
                                                                        className="size-3 shrink-0 fill-amber-400 text-amber-400"
                                                                        aria-label="Starred"
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
                                                        <RelativeTime iso={entry.createdAt} />
                                                    </div>
                                                    <div className="hidden w-44 shrink-0 truncate px-2 text-muted-foreground sm:block">
                                                        <RelativeTime iso={entry.modifiedAt} />
                                                    </div>
                                                    <div className="w-24 shrink-0 px-2 text-muted-foreground">
                                                        {entry.kind === "dir" ? "-" : formatBytes(BigInt(entry.size))}
                                                    </div>
                                                    <div className="flex w-12 shrink-0 justify-end px-2">
                                                        <Button
                                                            size="icon"
                                                            variant="ghost"
                                                            onClick={() => onShare(entry)}
                                                            aria-label={`Share ${entry.name}`}
                                                        >
                                                            <Share2 className="size-4" />
                                                        </Button>
                                                    </div>
                                                </div>
                                            </ContextMenuTrigger>
                                            <ContextMenuContent>
                                                <ContextMenuLabel>{entry.name}</ContextMenuLabel>
                                                {entry.kind === "dir" ? (
                                                    <>
                                                        <ContextMenuItem asChild>
                                                            <Link href={href(connectionId, entry.path)}>
                                                                <Folder className="size-4" />
                                                                Open
                                                            </Link>
                                                        </ContextMenuItem>
                                                        <ContextMenuItem
                                                            onSelect={() =>
                                                                downloadSelection(
                                                                    connectionId,
                                                                    selected.has(entry.path) ? selectedEntries : [entry]
                                                                )
                                                            }
                                                        >
                                                            <Download className="size-4" />
                                                            Download as ZIP
                                                        </ContextMenuItem>
                                                        <ContextMenuItem
                                                            onSelect={() => onRequestFiles(entry.path, entry.name)}
                                                        >
                                                            <Inbox className="size-4" />
                                                            Request files here
                                                        </ContextMenuItem>
                                                        {clipboard ? (
                                                            <ContextMenuItem
                                                                onSelect={() => {
                                                                    for (const item of clipboard.entries) {
                                                                        if (clipboard.mode === "cut")
                                                                            onMove(item, entry.path);
                                                                        else onCopy(item, entry.path);
                                                                    }
                                                                    if (clipboard.mode === "cut") setClipboard(null);
                                                                }}
                                                            >
                                                                <ClipboardPaste className="size-4" />
                                                                Paste here
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
                                                        <ContextMenuItem
                                                            onSelect={() =>
                                                                downloadSelection(
                                                                    connectionId,
                                                                    selected.has(entry.path) ? selectedEntries : [entry]
                                                                )
                                                            }
                                                        >
                                                            <Download className="size-4" />
                                                            Download
                                                        </ContextMenuItem>
                                                    </>
                                                )}
                                                <ContextMenuItem onSelect={() => startRename(entry)}>
                                                    <Pencil className="size-4" />
                                                    Rename
                                                    <span className="ml-auto pl-6 text-xs text-muted-foreground">F2</span>
                                                </ContextMenuItem>
                                                <ContextMenuItem
                                                    onSelect={() =>
                                                        setClipboard({
                                                            entries: selected.has(entry.path) ? selectedEntries : [entry],
                                                            mode: "copy"
                                                        })
                                                    }
                                                >
                                                    <Copy className="size-4" />
                                                    Copy
                                                    <span className="ml-auto pl-6 text-xs text-muted-foreground">
                                                        Ctrl+C
                                                    </span>
                                                </ContextMenuItem>
                                                <ContextMenuItem
                                                    onSelect={() =>
                                                        setClipboard({
                                                            entries: selected.has(entry.path) ? selectedEntries : [entry],
                                                            mode: "cut"
                                                        })
                                                    }
                                                >
                                                    <Scissors className="size-4" />
                                                    Cut
                                                    <span className="ml-auto pl-6 text-xs text-muted-foreground">
                                                        Ctrl+X
                                                    </span>
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => duplicate(entry)}>
                                                    <Files className="size-4" />
                                                    Duplicate
                                                </ContextMenuItem>
                                                <ContextMenuItem
                                                    onSelect={() =>
                                                        openMove(selected.has(entry.path) ? selectedEntries : [entry])
                                                    }
                                                >
                                                    <FolderInput className="size-4" />
                                                    Move to...
                                                </ContextMenuItem>
                                                <ContextMenuItem
                                                    onSelect={() => void navigator.clipboard.writeText(entry.path)}
                                                >
                                                    <ClipboardCopy className="size-4" />
                                                    Copy path
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => onShare(entry)}>
                                                    <Share2 className="size-4" />
                                                    Share
                                                </ContextMenuItem>
                                                <ContextMenuSeparator />
                                                <ContextMenuItem onSelect={() => onToggleFavorite(entry)}>
                                                    {entry.favorite ? (
                                                        <StarOff className="size-4" />
                                                    ) : (
                                                        <Star className="size-4" />
                                                    )}
                                                    {entry.favorite ? "Remove star" : "Add to favorites"}
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => setIconTarget(entry)}>
                                                    <Palette className="size-4" />
                                                    Change icon
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => onToggleHidden(entry)}>
                                                    {entry.hidden ? (
                                                        <Eye className="size-4" />
                                                    ) : (
                                                        <EyeOff className="size-4" />
                                                    )}
                                                    {entry.hidden ? "Unhide" : "Hide"}
                                                </ContextMenuItem>
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
                                                <ContextMenuSeparator />
                                                <ContextMenuItem variant="danger" onSelect={() => onDelete([entry])}>
                                                    <Trash2 className="size-4" />
                                                    Delete
                                                    <span className="ml-auto pl-6 text-xs text-muted-foreground">Del</span>
                                                </ContextMenuItem>
                                            </ContextMenuContent>
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
                </ContextMenuItem>
                <ContextMenuItem onSelect={onNewFile}>
                    <FilePlus className="size-4" />
                    New file
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => fileInput.current?.click()}>
                    <Upload className="size-4" />
                    Upload files
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => folderInput.current?.click()}>
                    <FolderUp className="size-4" />
                    Upload folder
                </ContextMenuItem>
                {clipboard ? (
                    <ContextMenuItem onSelect={paste}>
                        <ClipboardPaste className="size-4" />
                        Paste
                    </ContextMenuItem>
                ) : null}
            </ContextMenuContent>
            </ContextMenu>
            {selectedEntries.length === 1 && selectedEntries[0] ? (
                <aside className="hidden w-64 shrink-0 flex-col gap-4 rounded-lg border border-border p-4 lg:flex">
                    <div className="flex flex-col items-center gap-2 text-center">
                        <EntryIcon entry={selectedEntries[0]} className="size-10" />
                        <span className="break-all text-sm font-medium">{selectedEntries[0].name}</span>
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
                            <dd className="text-right">
                                {selectedEntries[0].kind === "dir"
                                    ? "-"
                                    : formatBytes(BigInt(selectedEntries[0].size))}
                            </dd>
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <dt className="text-muted-foreground">Location</dt>
                            <dd className="break-all">/{selectedEntries[0].path.split("/").slice(0, -1).join("/")}</dd>
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <dt className="text-muted-foreground">Created on</dt>
                            <dd>{new Date(selectedEntries[0].createdAt).toLocaleString()}</dd>
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <dt className="text-muted-foreground">Last Modified</dt>
                            <dd>{new Date(selectedEntries[0].modifiedAt).toLocaleString()}</dd>
                        </div>
                    </dl>
                    <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" variant="secondary" onClick={() => selectedEntries[0] && openEntry(selectedEntries[0])}>
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
                            onClick={() => selectedEntries[0] && void navigator.clipboard.writeText(selectedEntries[0].path)}
                        >
                            <ClipboardCopy className="size-4" />
                            Copy path
                        </Button>
                    </div>
                    <div className="flex flex-col gap-1 border-t border-border pt-3">
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
                            <p className="whitespace-pre-line text-xs text-muted-foreground">{selectedEntries[0].note}</p>
                        ) : (
                            <p className="text-xs text-muted-foreground/60">No note</p>
                        )}
                    </div>
                </aside>
            ) : null}
            </div>

            <FileViewer
                target={viewerTarget}
                onOpenChange={(open) => !open && setViewerTarget(null)}
                onShare={(t) =>
                    onShare({
                        name: t.name,
                        path: t.path,
                        kind: "file",
                        size: t.size ?? "0",
                        modifiedAt: t.modifiedAt ?? new Date().toISOString(),
                        createdAt: t.modifiedAt ?? new Date().toISOString()
                    })
                }
            />

            <Dialog open={iconTarget !== null} onOpenChange={(open) => !open && setIconTarget(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Change icon</DialogTitle>
                        <DialogDescription className="truncate">{iconTarget?.name}</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4">
                        <div className="grid grid-cols-7 gap-1.5">
                            {Object.entries(ITEM_ICONS).map(([name, Icon]) => (
                                <button
                                    key={name}
                                    type="button"
                                    onClick={() => {
                                        if (!iconTarget) return;
                                        onSetIcon(iconTarget, name, iconTarget.iconColor ?? "primary");
                                        setIconTarget({ ...iconTarget, icon: name });
                                    }}
                                    className={cn(
                                        "flex items-center justify-center rounded-md border p-2 transition-colors hover:bg-muted",
                                        iconTarget?.icon === name ? "border-primary" : "border-border"
                                    )}
                                >
                                    <Icon className={cn("size-5", iconColorClass(iconTarget?.iconColor))} />
                                </button>
                            ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {ITEM_ICON_COLORS.map((color) => (
                                <button
                                    key={color.id}
                                    type="button"
                                    aria-label={color.id}
                                    onClick={() => {
                                        if (!iconTarget) return;
                                        onSetIcon(iconTarget, iconTarget.icon ?? "folder", color.id);
                                        setIconTarget({ ...iconTarget, icon: iconTarget.icon ?? "folder", iconColor: color.id });
                                    }}
                                    className={cn(
                                        "size-6 rounded-full ring-offset-2 ring-offset-background transition",
                                        iconTarget?.iconColor === color.id ? "ring-2 ring-primary" : ""
                                    )}
                                >
                                    <span className={cn("block size-full rounded-full", color.swatch)} />
                                </button>
                            ))}
                        </div>
                        <div className="flex justify-between">
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    if (iconTarget) onSetIcon(iconTarget, null, null);
                                    setIconTarget(null);
                                }}
                            >
                                Reset to default
                            </Button>
                            <Button type="button" size="sm" onClick={() => setIconTarget(null)}>
                                Done
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={detailsTarget !== null} onOpenChange={(open) => !open && setDetailsTarget(null)}>
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
                            <dd>
                                {detailsTarget.kind === "dir"
                                    ? "-"
                                    : `${formatBytes(BigInt(detailsTarget.size))} (${Number(detailsTarget.size).toLocaleString()} bytes)`}
                            </dd>
                            <dt className="text-muted-foreground">Modified</dt>
                            <dd>{new Date(detailsTarget.modifiedAt).toLocaleString()}</dd>
                        </dl>
                    ) : null}
                </DialogContent>
            </Dialog>

            <Dialog open={noteTarget !== null} onOpenChange={(open) => !open && setNoteTarget(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Note</DialogTitle>
                        <DialogDescription className="truncate">{noteTarget?.name}</DialogDescription>
                    </DialogHeader>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (noteTarget) onSetNote(noteTarget, noteValue.trim() || null);
                            setNoteTarget(null);
                        }}
                        className="flex flex-col gap-3"
                    >
                        <textarea
                            autoFocus
                            value={noteValue}
                            onChange={(event) => setNoteValue(event.target.value)}
                            rows={4}
                            placeholder="Add a note for this item..."
                            className="rounded-md border border-input bg-surface px-3 py-2 text-sm"
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

            <Dialog open={moveTargets !== null} onOpenChange={(open) => !open && setMoveTargets(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            Move {moveTargets && moveTargets.length > 1 ? `${moveTargets.length} items` : "item"}
                        </DialogTitle>
                        <DialogDescription>
                            Destination folder (relative to the connection root; empty means the root).
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={submitMove} className="flex flex-col gap-3">
                        <Input
                            autoFocus
                            value={moveDest}
                            onChange={(event) => setMoveDest(event.target.value)}
                            placeholder="e.g. Documents/Archive"
                        />
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => setMoveTargets(null)}>
                                Cancel
                            </Button>
                            <Button type="submit">Move</Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** The icon for an entry - a user-set custom icon/color, or the default by kind. */
function EntryIcon({ entry, className = "size-4" }: { entry: DriveEntry; className?: string }) {
    const Custom = iconComponent(entry.icon);
    if (Custom) return <Custom className={cn(className, iconColorClass(entry.iconColor))} />;
    return entry.kind === "dir" ? (
        <Folder className={cn(className, "text-primary")} />
    ) : (
        <File className={cn(className, "text-muted-foreground")} />
    );
}

interface UploadItem {
    file: File;
    relPath: string;
}

/** Map a FileList to upload items, preserving folder structure when present. */
function filesToItems(fileList: FileList): UploadItem[] {
    return Array.from(fileList).map((file) => ({
        file,
        relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    }));
}

/** Read every batch from a directory reader (readEntries returns in chunks). */
function readAllEntries(reader: { readEntries: (cb: (entries: unknown[]) => void, err: (e: unknown) => void) => void }): Promise<unknown[]> {
    return new Promise((resolve) => {
        const all: unknown[] = [];
        const next = () => {
            reader.readEntries((batch) => {
                if (batch.length === 0) resolve(all);
                else {
                    all.push(...batch);
                    next();
                }
            }, () => resolve(all));
        };
        next();
    });
}

/**
 * Collect files (with folder-relative paths) from a drag-and-drop, walking any
 * dropped directories via the FileSystem entry API. Falls back to the flat file
 * list when the browser does not expose directory entries.
 */
async function gatherDropItems(dataTransfer: DataTransfer): Promise<UploadItem[]> {
    const roots: unknown[] = [];
    for (let index = 0; index < dataTransfer.items.length; index++) {
        const item = dataTransfer.items[index] as DataTransferItem & { webkitGetAsEntry?: () => unknown };
        const entry = item.webkitGetAsEntry?.();
        if (entry) roots.push(entry);
    }
    if (roots.length === 0) return filesToItems(dataTransfer.files);

    const out: UploadItem[] = [];
    const walk = async (entry: unknown, prefix: string): Promise<void> => {
        const node = entry as {
            isFile?: boolean;
            isDirectory?: boolean;
            name: string;
            file?: (cb: (file: File) => void, err: (e: unknown) => void) => void;
            createReader?: () => { readEntries: (cb: (entries: unknown[]) => void, err: (e: unknown) => void) => void };
        };
        if (node.isFile && node.file) {
            const file = await new Promise<File | null>((resolve) => node.file!(resolve, () => resolve(null)));
            if (file) out.push({ file, relPath: `${prefix}${node.name}` });
        } else if (node.isDirectory && node.createReader) {
            const children = await readAllEntries(node.createReader());
            for (const child of children) await walk(child, `${prefix}${node.name}/`);
        }
    };
    for (const root of roots) await walk(root, "");
    return out;
}

/** Placeholder while a directory listing loads. */
function ListingSkeleton() {
    return (
        <div className="flex flex-col">
            {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3 px-3 py-2.5">
                    <Skeleton className="size-4 rounded" />
                    <Skeleton className="h-4 flex-1 max-w-[40%]" />
                    <Skeleton className="ml-auto h-4 w-16" />
                </div>
            ))}
        </div>
    );
}
