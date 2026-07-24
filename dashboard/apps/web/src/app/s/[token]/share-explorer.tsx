"use client";

/**
 * Public Drive explorer for a folder share. It mirrors the in-app Files browser a
 * signed-in user sees - breadcrumb, search (this folder or the whole subtree),
 * sort, list/grid, type/size/date filters, multi-select, inline preview, and
 * per-item or bundled ZIP download - and exposes exactly the actions the share
 * permits: browse always; preview/download per their flags; and, when the owner
 * enabled them, write actions (upload/drop box, create folder, rename/move,
 * delete). Every request is re-gated server-side by the token routes, so the
 * client is purely presentational and a disabled action is also refused by the
 * server. Navigation is URL-driven (?p=path) via the History API so links are
 * shareable and the back button works, without a server round-trip per folder.
 */

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type MouseEvent
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Fuse from "fuse.js";
import {
    ArrowDownAZ,
    ArrowUpAZ,
    ChevronRight,
    ClipboardCopy,
    Download,
    Eye,
    File,
    Folder,
    FolderOpen,
    FolderPlus,
    FolderTree,
    Info,
    LayoutGrid,
    List,
    Loader2,
    Pencil,
    Search,
    SlidersHorizontal,
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
    FILE_CATEGORIES,
    categoryOfExtension,
    extensionOf,
    type FileCategory
} from "@/app/(app)/drive/file-categories";
import { FileViewer, isViewable, type ViewerTarget } from "@/app/(app)/drive/file-viewer";
import { iconColorClass, iconComponent } from "@/app/(app)/drive/item-icons";
import { matchesStructured, parseSearch } from "@/app/(app)/drive/search-query";
import { RelativeTime } from "@/components/relative-time";
import type { DriveEntry } from "@/app/(app)/drive/types";

type SortKey = "name" | "created" | "modified" | "size";
type SortDir = "asc" | "desc";

const ROW_HEIGHT = 40;

/** URL of the token download route for a single path (attachment or inline preview). */
function fileUrl(token: string, path: string, inline: boolean): string {
    const query = new URLSearchParams({ p: path });
    if (inline) query.set("disposition", "inline");
    return `/api/s/${token}/download?${query.toString()}`;
}

/** URL of the token ZIP route bundling several paths (files and/or folders). */
function zipUrl(token: string, paths: string[]): string {
    const query = new URLSearchParams();
    for (const path of paths) query.append("p", path);
    return `/api/s/${token}/zip?${query.toString()}`;
}

/** Kick off a download without leaving the page (a single navigation, never blocked). */
function openHref(href: string, downloadName?: string) {
    const anchor = document.createElement("a");
    anchor.href = href;
    if (downloadName) anchor.download = downloadName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

/** Parent folder path of a relative path ("a/b/c" -> "a/b"). */
function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
}

/** A short, non-leaky message for a failed write, from the route's status/reason. */
function writeErrorMessage(status: number, reason: string): string {
    if (reason.endsWith("_disabled") || status === 403) return "That action is not allowed on this link.";
    if (reason === "cannot_rename_root" || reason === "cannot_delete_root") {
        return "The shared folder itself cannot be changed.";
    }
    if (reason === "path_outside_share") return "That location is outside the shared folder.";
    if (status === 410) return "This link is no longer available.";
    return "The action could not be completed. The item may be in use or protected.";
}

export function ShareExplorer({
    token,
    rootName,
    rootPath,
    initialPath,
    allowDownload,
    allowPreview,
    allowUpload,
    allowRename,
    allowDelete,
    allowCreateFolder
}: {
    token: string;
    rootName: string;
    rootPath: string;
    initialPath: string;
    allowDownload: boolean;
    allowPreview: boolean;
    allowUpload: boolean;
    allowRename: boolean;
    allowDelete: boolean;
    allowCreateFolder: boolean;
}) {
    const [path, setPath] = useState(initialPath);
    const [entries, setEntries] = useState<DriveEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Bumped after a write to re-fetch the listing (and any active search).
    const [reloadKey, setReloadKey] = useState(0);

    const [query, setQuery] = useState("");
    const [searchScope, setSearchScope] = useState<"current" | "recursive">("recursive");
    const [remoteEntries, setRemoteEntries] = useState<DriveEntry[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchTruncated, setSearchTruncated] = useState(false);

    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [viewMode, setViewMode] = useState<"list" | "grid">("list");
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [categories, setCategories] = useState<Set<FileCategory>>(new Set());
    const [extFilter, setExtFilter] = useState("");
    const [minMb, setMinMb] = useState("");
    const [maxMb, setMaxMb] = useState("");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");

    const [selected, setSelected] = useState<Set<string>>(new Set());
    const lastIndex = useRef<number | null>(null);
    const [viewerTarget, setViewerTarget] = useState<ViewerTarget | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Write state (only reachable when the matching flag is set).
    const [opError, setOpError] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [dragUpload, setDragUpload] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [renameTarget, setRenameTarget] = useState<DriveEntry | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [deleteTargets, setDeleteTargets] = useState<DriveEntry[] | null>(null);

    /** Build the shareable URL for a path within the subtree (root omits `?p`). */
    const urlForPath = useCallback(
        (target: string) => (target && target !== rootPath ? `/s/${token}?p=${encodeURIComponent(target)}` : `/s/${token}`),
        [token, rootPath]
    );

    /** Navigate to a folder within the subtree, updating the address bar (History API). */
    const navigate = useCallback(
        (next: string) => {
            setPath(next);
            window.history.pushState({}, "", urlForPath(next));
        },
        [urlForPath]
    );

    const reload = useCallback(() => setReloadKey((key) => key + 1), []);

    // Keep the view in sync with back/forward navigation.
    useEffect(() => {
        function onPop() {
            const param = new URLSearchParams(window.location.search).get("p");
            setPath(param ?? rootPath);
        }
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, [rootPath]);

    // Load the current folder's listing. Re-gated server-side on every fetch.
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        const search = new URLSearchParams();
        if (path && path !== rootPath) search.set("p", path);
        fetch(`/api/s/${token}/list?${search.toString()}`, { signal: controller.signal })
            .then(async (res) => {
                const body = await res.json();
                if (controller.signal.aborted) return;
                if (!res.ok) {
                    setEntries([]);
                    setError("This folder could not be opened.");
                    return;
                }
                setEntries(Array.isArray(body.entries) ? (body.entries as DriveEntry[]) : []);
            })
            .catch(() => {
                if (!controller.signal.aborted) setError("This folder could not be opened.");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [token, path, rootPath, reloadKey]);

    // Drop selection whenever the folder or the searched result set changes.
    useEffect(() => {
        setSelected(new Set());
        lastIndex.current = null;
    }, [path, remoteEntries]);

    // Recursive search: walk the subtree server-side (debounced) when scoped so.
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
            const search = new URLSearchParams({ q: query });
            if (path && path !== rootPath) search.set("p", path);
            fetch(`/api/s/${token}/search?${search.toString()}`, { signal: controller.signal })
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
    }, [searchScope, query, token, path, rootPath, reloadKey]);

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
            const fuse = new Fuse(rows, {
                keys: [parsed.pathMode ? "path" : "name"],
                threshold: 0.4,
                ignoreLocation: true
            });
            rows = fuse.search(parsed.fuzzy).map((result) => result.item);
        }

        const direction = sortDir === "asc" ? 1 : -1;
        return [...rows].sort((a, b) => {
            const dirA = a.kind === "dir" ? 0 : 1;
            const dirB = b.kind === "dir" ? 0 : 1;
            if (dirA !== dirB) return dirA - dirB;
            if (sortKey === "size") return (Number(a.size) - Number(b.size)) * direction;
            if (sortKey === "created")
                return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * direction;
            if (sortKey === "modified")
                return (new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()) * direction;
            return a.name.localeCompare(b.name) * direction;
        });
    }, [source, categories, extFilter, minMb, maxMb, dateFrom, dateTo, query, sortKey, sortDir]);

    const selectedEntries = visible.filter((entry) => selected.has(entry.path));
    const allSelected = visible.length > 0 && selectedEntries.length === visible.length;
    const searchError = useMemo(() => parseSearch(query).error, [query]);

    const rowVirtualizer = useVirtualizer({
        count: visible.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12
    });

    // Breadcrumb segments relative to the shared root.
    const rel = path === rootPath ? "" : path.slice(rootPath ? rootPath.length + 1 : 0);
    const segments = rel ? rel.split("/") : [];

    function openViewer(entry: DriveEntry) {
        // Location shown relative to the shared root (never the connection path above
        // it), mirroring the breadcrumb the visitor can already see.
        const parent = parentOf(entry.path);
        const parentRel = parent === rootPath ? "" : parent.slice(rootPath ? rootPath.length + 1 : 0);
        setViewerTarget({
            path: entry.path,
            name: entry.name,
            size: entry.size,
            modifiedAt: entry.modifiedAt,
            locationLabel: parentRel ? `${rootName}/${parentRel}` : rootName
        });
    }

    /** Open an item: folders navigate; files preview when allowed, else download. */
    function openEntry(entry: DriveEntry) {
        if (entry.kind === "dir") {
            navigate(entry.path);
            return;
        }
        if (allowPreview && isViewable(entry.name)) openViewer(entry);
        else if (allowDownload) openHref(fileUrl(token, entry.path, false), entry.name);
    }

    /** Download a selection: a single file streams directly, anything else as one ZIP. */
    function downloadSelection(items: DriveEntry[]) {
        if (!allowDownload || items.length === 0) return;
        if (items.length === 1 && items[0] && items[0].kind !== "dir") {
            openHref(fileUrl(token, items[0].path, false), items[0].name);
            return;
        }
        openHref(zipUrl(token, items.map((entry) => entry.path)));
    }

    /** POST a JSON write to a token route; surface a friendly error, reload on success. */
    async function writeJson(action: string, payload: Record<string, unknown>): Promise<boolean> {
        setOpError(null);
        try {
            const res = await fetch(`/api/s/${token}/${action}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const reason = await res.text().catch(() => "");
                setOpError(writeErrorMessage(res.status, reason.trim()));
                return false;
            }
            return true;
        } catch {
            setOpError("The action could not be completed.");
            return false;
        }
    }

    /** Upload files into the current folder (drop box). relPath is name-relative. */
    async function uploadFiles(items: { file: File; relPath: string }[]) {
        if (!allowUpload || items.length === 0) return;
        setUploading(true);
        setOpError(null);
        let failed = 0;
        for (const { file, relPath } of items) {
            const q = new URLSearchParams({ name: relPath });
            if (path) q.set("p", path);
            try {
                const res = await fetch(`/api/s/${token}/upload?${q.toString()}`, {
                    method: "PUT",
                    body: file
                });
                if (!res.ok) failed++;
            } catch {
                failed++;
            }
        }
        setUploading(false);
        if (fileInput.current) fileInput.current.value = "";
        if (failed > 0) setOpError(`${failed} file${failed === 1 ? "" : "s"} could not be uploaded.`);
        reload();
    }

    async function submitNewFolder(event: React.FormEvent) {
        event.preventDefault();
        const name = newFolderName.trim();
        if (!name) return;
        setNewFolderOpen(false);
        setNewFolderName("");
        if (await writeJson("mkdir", { parent: path, name })) reload();
    }

    async function submitRename(event: React.FormEvent) {
        event.preventDefault();
        if (!renameTarget) return;
        const name = renameValue.trim();
        const target = renameTarget;
        setRenameTarget(null);
        if (!name || name === target.name) return;
        const to = parentOf(target.path) ? `${parentOf(target.path)}/${name}` : name;
        if (await writeJson("rename", { from: target.path, to })) reload();
    }

    async function confirmDelete() {
        if (!deleteTargets) return;
        const targets = deleteTargets;
        setDeleteTargets(null);
        setOpError(null);
        let failed = 0;
        for (const entry of targets) {
            try {
                const res = await fetch(`/api/s/${token}/delete`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ path: entry.path })
                });
                if (!res.ok) failed++;
            } catch {
                failed++;
            }
        }
        setSelected(new Set());
        if (failed > 0) setOpError(`${failed} item${failed === 1 ? "" : "s"} could not be deleted.`);
        reload();
    }

    /** Drag files over the listing highlights it as a drop zone (upload shares only). */
    function onUploadDragOver(event: React.DragEvent) {
        if (!allowUpload || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragUpload(true);
    }

    function onUploadDrop(event: React.DragEvent) {
        if (!allowUpload || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragUpload(false);
        const files = Array.from(event.dataTransfer.files);
        void uploadFiles(files.map((file) => ({ file, relPath: file.name })));
    }

    function toggleOne(key: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
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

    /** Windows-style click: plain selects only this, ctrl toggles, shift extends. */
    function rowClick(event: MouseEvent, index: number, entry: DriveEntry) {
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

    function toggleAll() {
        setSelected(allSelected ? new Set() : new Set(visible.map((entry) => entry.path)));
    }

    function startRename(entry: DriveEntry) {
        setRenameValue(entry.name);
        setRenameTarget(entry);
    }

    function onListKeyDown(event: KeyboardEvent) {
        const mod = event.ctrlKey || event.metaKey;
        if (event.key === "Escape" && selectedEntries.length > 0) {
            event.preventDefault();
            setSelected(new Set());
        } else if (mod && event.key.toLowerCase() === "a") {
            event.preventDefault();
            setSelected(new Set(visible.map((entry) => entry.path)));
        } else if (event.key === "Enter" && selectedEntries.length === 1 && selectedEntries[0]) {
            event.preventDefault();
            openEntry(selectedEntries[0]);
        } else if (event.key === "F2" && allowRename && selectedEntries.length === 1 && selectedEntries[0]) {
            event.preventDefault();
            startRename(selectedEntries[0]);
        } else if (event.key === "Delete" && allowDelete && selectedEntries.length > 0) {
            event.preventDefault();
            setDeleteTargets(selectedEntries);
        }
    }

    function toggleCategory(id: FileCategory) {
        setCategories((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    /** Icon + color for an entry (custom folder icon, or a type-derived default). */
    function EntryIcon({ entry, className }: { entry: DriveEntry; className?: string }) {
        const custom = iconComponent(entry.icon);
        if (custom) {
            const Custom = custom;
            return <Custom className={cn(className, iconColorClass(entry.iconColor))} />;
        }
        if (entry.kind === "dir") return <Folder className={cn(className, "text-primary")} />;
        return <File className={cn(className, "text-muted-foreground")} />;
    }

    const rowActions = (entry: DriveEntry) => (
        <>
            {allowPreview && entry.kind !== "dir" && isViewable(entry.name) ? (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        openViewer(entry);
                    }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Preview ${entry.name}`}
                >
                    <Eye className="size-4" />
                </button>
            ) : null}
            {allowDownload ? (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        downloadSelection([entry]);
                    }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Download ${entry.name}`}
                >
                    <Download className="size-4" />
                </button>
            ) : null}
        </>
    );

    const entryMenu = (entry: DriveEntry) => (
        <ContextMenuContent>
            <ContextMenuLabel>{entry.name}</ContextMenuLabel>
            <ContextMenuItem onSelect={() => openEntry(entry)}>
                {entry.kind === "dir" ? <Folder className="size-4" /> : <Eye className="size-4" />}
                Open
            </ContextMenuItem>
            {allowDownload ? (
                <ContextMenuItem onSelect={() => downloadSelection([entry])}>
                    <Download className="size-4" />
                    {entry.kind === "dir" ? "Download as ZIP" : "Download"}
                </ContextMenuItem>
            ) : null}
            {allowRename ? (
                <ContextMenuItem onSelect={() => startRename(entry)}>
                    <Pencil className="size-4" />
                    Rename
                </ContextMenuItem>
            ) : null}
            <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(entry.name)}>
                <ClipboardCopy className="size-4" />
                Copy name
            </ContextMenuItem>
            {allowDelete ? (
                <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        variant="danger"
                        onSelect={() => setDeleteTargets(selected.has(entry.path) ? selectedEntries : [entry])}
                    >
                        <Trash2 className="size-4" />
                        Delete
                    </ContextMenuItem>
                </>
            ) : null}
        </ContextMenuContent>
    );

    return (
        <div className="flex min-w-0 flex-1 flex-col">
            {/* Breadcrumb + folder-level actions */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
                    <FolderOpen className="size-4 shrink-0" />
                    <button
                        type="button"
                        onClick={() => navigate(rootPath)}
                        className="rounded px-1 py-0.5 hover:text-foreground"
                    >
                        {rootName}
                    </button>
                    {segments.map((segment, index) => {
                        const target = `${rootPath ? `${rootPath}/` : ""}${segments.slice(0, index + 1).join("/")}`;
                        return (
                            <span key={target} className="flex min-w-0 items-center gap-1">
                                <ChevronRight className="size-3 shrink-0" />
                                <button
                                    type="button"
                                    onClick={() => navigate(target)}
                                    className="truncate rounded px-1 py-0.5 hover:text-foreground"
                                >
                                    {segment}
                                </button>
                            </span>
                        );
                    })}
                </div>
                <div className="flex items-center gap-2">
                    {allowCreateFolder ? (
                        <Button size="sm" variant="ghost" onClick={() => setNewFolderOpen(true)}>
                            <FolderPlus className="size-4" />
                            New folder
                        </Button>
                    ) : null}
                    {allowUpload ? (
                        <>
                            <Button size="sm" variant="secondary" disabled={uploading} onClick={() => fileInput.current?.click()}>
                                <Upload className="size-4" />
                                {uploading ? "Uploading..." : "Upload"}
                            </Button>
                            <input
                                ref={fileInput}
                                type="file"
                                multiple
                                hidden
                                onChange={(event) => {
                                    const files = event.target.files ? Array.from(event.target.files) : [];
                                    void uploadFiles(files.map((file) => ({ file, relPath: file.name })));
                                }}
                            />
                        </>
                    ) : null}
                    {allowDownload && visible.length > 0 && (path || rootPath) ? (
                        <Button size="sm" variant="ghost" onClick={() => openHref(zipUrl(token, [path || rootPath]))}>
                            <Download className="size-4" />
                            Download all
                        </Button>
                    ) : null}
                </div>
            </div>

            {/* Search + sort + view + filters toolbar */}
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
                        onClick={() => setSearchScope((prev) => (prev === "current" ? "recursive" : "current"))}
                        aria-label="Toggle search scope"
                        title={
                            searchScope === "recursive"
                                ? "Searching this folder and all subfolders. Click to search only this folder."
                                : "Searching only this folder. Click to search all subfolders too."
                        }
                        className={cn(
                            "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition-colors hover:bg-muted",
                            searchScope === "recursive" ? "text-primary" : "text-muted-foreground"
                        )}
                    >
                        {searchScope === "recursive" ? (
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
                        {sortDir === "asc" ? (
                            <ArrowDownAZ className="size-4" />
                        ) : (
                            <ArrowUpAZ className="size-4" />
                        )}
                    </button>
                </div>
                <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                    <button
                        type="button"
                        onClick={() => setViewMode("list")}
                        aria-label="List view"
                        className={cn(
                            "rounded p-1 transition-colors hover:bg-muted",
                            viewMode === "list" ? "bg-muted text-foreground" : "text-muted-foreground"
                        )}
                    >
                        <List className="size-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setViewMode("grid")}
                        aria-label="Grid view"
                        className={cn(
                            "rounded p-1 transition-colors hover:bg-muted",
                            viewMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground"
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
            </div>

            {searchScope === "recursive" && query.trim() ? (
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

            {/* Selection action bar (fixed height so selecting never reflows the list). */}
            <div
                className={cn(
                    "mb-3 flex h-10 items-center gap-2 rounded-md border px-3 text-sm transition-colors",
                    selectedEntries.length > 0 ? "border-primary/40 bg-primary/5" : "border-transparent"
                )}
            >
                {selectedEntries.length > 0 ? (
                    <>
                        <span className="font-medium">{selectedEntries.length} selected</span>
                        <div className="ml-auto flex items-center gap-1">
                            {allowDownload ? (
                                <Button size="sm" variant="ghost" onClick={() => downloadSelection(selectedEntries)}>
                                    <Download className="size-4" />
                                    {selectedEntries.length > 1 || selectedEntries.some((entry) => entry.kind === "dir")
                                        ? "Download ZIP"
                                        : "Download"}
                                </Button>
                            ) : null}
                            {allowRename && selectedEntries.length === 1 && selectedEntries[0] ? (
                                <Button size="sm" variant="ghost" onClick={() => startRename(selectedEntries[0]!)}>
                                    <Pencil className="size-4" />
                                    Rename
                                </Button>
                            ) : null}
                            {allowDelete ? (
                                <Button size="sm" variant="ghost" onClick={() => setDeleteTargets(selectedEntries)}>
                                    <Trash2 className="size-4" />
                                    Delete
                                </Button>
                            ) : null}
                            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                                <X className="size-4" />
                                Clear
                            </Button>
                        </div>
                    </>
                ) : (
                    <span className="text-xs text-muted-foreground">
                        {allowUpload
                            ? "Drop files here to upload, or open an item to preview."
                            : allowDownload
                              ? "Select items to download, or open one to preview."
                              : "Open an item to preview it."}
                    </span>
                )}
            </div>

            {/* Listing (also the upload drop zone when the share allows uploads). */}
            <div
                className="relative"
                onDragOver={onUploadDragOver}
                onDragLeave={() => setDragUpload(false)}
                onDrop={onUploadDrop}
            >
                {dragUpload ? (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
                        <Upload className="mr-2 size-4" />
                        Drop files to upload here
                    </div>
                ) : null}

                {loading ? (
                    <div className="flex flex-col gap-1">
                        {Array.from({ length: 8 }).map((_, index) => (
                            <Skeleton key={index} className="h-9 w-full" />
                        ))}
                    </div>
                ) : error ? (
                    <p className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        {error}
                    </p>
                ) : visible.length === 0 ? (
                    <p className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        {query.trim()
                            ? "No items match your search."
                            : allowUpload
                              ? "This folder is empty. Drop files here or use Upload to add some."
                              : "This folder is empty."}
                    </p>
                ) : viewMode === "grid" ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                        {visible.map((entry, index) => (
                            <ContextMenu key={entry.path}>
                                <ContextMenuTrigger asChild>
                                    <button
                                        type="button"
                                        onClick={(event) => rowClick(event, index, entry)}
                                        onDoubleClick={() => openEntry(entry)}
                                        className={cn(
                                            "group flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors",
                                            selected.has(entry.path)
                                                ? "border-primary/50 bg-primary/5"
                                                : "border-border hover:bg-card-hover"
                                        )}
                                    >
                                        <EntryIcon entry={entry} className="size-10" />
                                        <span className="line-clamp-2 w-full break-words text-xs">{entry.name}</span>
                                        {entry.kind !== "dir" ? (
                                            <span className="text-[10px] text-muted-foreground">
                                                {formatBytes(BigInt(entry.size))}
                                            </span>
                                        ) : null}
                                    </button>
                                </ContextMenuTrigger>
                                {entryMenu(entry)}
                            </ContextMenu>
                        ))}
                    </div>
                ) : (
                    <div
                        tabIndex={0}
                        onKeyDown={onListKeyDown}
                        className="flex flex-col rounded-md border border-border outline-none"
                    >
                        <div className="flex items-center gap-3 border-b border-border bg-surface/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                            <Checkbox
                                checked={allSelected}
                                indeterminate={!allSelected && selectedEntries.length > 0}
                                onChange={toggleAll}
                                aria-label="Select all"
                            />
                            <span className="flex-1">Name</span>
                            <span className="hidden w-40 sm:block">Modified</span>
                            <span className="w-20 text-right">Size</span>
                            <span className="w-16" />
                        </div>
                        <div ref={scrollRef} className="max-h-[60vh] overflow-auto">
                            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                                {rowVirtualizer.getVirtualItems().map((row) => {
                                    const entry = visible[row.index];
                                    if (!entry) return null;
                                    const isSelected = selected.has(entry.path);
                                    return (
                                        <ContextMenu key={entry.path}>
                                            <ContextMenuTrigger asChild>
                                                <div
                                                    data-share-row
                                                    onClick={(event) => rowClick(event, row.index, entry)}
                                                    onDoubleClick={() => openEntry(entry)}
                                                    style={{
                                                        position: "absolute",
                                                        top: 0,
                                                        left: 0,
                                                        width: "100%",
                                                        height: ROW_HEIGHT,
                                                        transform: `translateY(${row.start}px)`
                                                    }}
                                                    className={cn(
                                                        "group flex cursor-default items-center gap-3 border-b border-border px-3 text-sm transition-colors",
                                                        isSelected ? "bg-primary/5" : "hover:bg-card-hover"
                                                    )}
                                                >
                                                    <Checkbox
                                                        checked={isSelected}
                                                        onClick={(event) => event.stopPropagation()}
                                                        onChange={() => toggleOne(entry.path)}
                                                        aria-label={`Select ${entry.name}`}
                                                    />
                                                    <EntryIcon entry={entry} className="size-4 shrink-0" />
                                                    <span className="flex-1 truncate">{entry.name}</span>
                                                    <span className="hidden w-40 text-xs text-muted-foreground sm:block">
                                                        <RelativeTime iso={entry.modifiedAt} />
                                                    </span>
                                                    <span className="w-20 text-right text-xs text-muted-foreground">
                                                        {entry.kind === "dir" ? "-" : formatBytes(BigInt(entry.size))}
                                                    </span>
                                                    <span className="flex w-16 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                                        {rowActions(entry)}
                                                    </span>
                                                </div>
                                            </ContextMenuTrigger>
                                            {entryMenu(entry)}
                                        </ContextMenu>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* New folder */}
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

            {/* Rename */}
            <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Rename</DialogTitle>
                        <DialogDescription className="truncate">{renameTarget?.name}</DialogDescription>
                    </DialogHeader>
                    <form onSubmit={submitRename} className="flex flex-col gap-3">
                        <Input
                            autoFocus
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            placeholder="New name"
                        />
                        <div className="flex justify-end gap-2">
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={!renameValue.trim()}>
                                Rename
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            {/* Delete confirm */}
            <Dialog open={deleteTargets !== null} onOpenChange={(open) => !open && setDeleteTargets(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            Delete {deleteTargets && deleteTargets.length > 1 ? `${deleteTargets.length} items` : "item"}
                        </DialogTitle>
                        <DialogDescription className="truncate">
                            {deleteTargets && deleteTargets.length === 1
                                ? `${deleteTargets[0]?.name} will be permanently deleted. This cannot be undone.`
                                : "The selected items will be permanently deleted. This cannot be undone."}
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

            {/* Background upload indicator */}
            {uploading ? (
                <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-sm shadow-lg">
                    <Loader2 className="size-4 animate-spin text-primary" />
                    Uploading...
                </div>
            ) : null}

            {/* Error toast for a failed write */}
            {opError ? (
                <div className="fixed bottom-4 right-4 z-50 flex w-80 items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger shadow-lg">
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

            <FileViewer
                target={viewerTarget}
                onOpenChange={(open) => !open && setViewerTarget(null)}
                urlFor={(target, inline) => fileUrl(token, target.path, inline)}
                readOnly
            />
        </div>
    );
}
