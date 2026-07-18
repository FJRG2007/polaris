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
import Fuse from "fuse.js";
import {
    ArrowDownAZ,
    ArrowUpAZ,
    ChevronRight,
    Download,
    File,
    Folder,
    FolderPlus,
    Pencil,
    Search,
    Share2,
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
    Input,
    Skeleton,
    cn
} from "@polaris/ui";
import { FILE_CATEGORIES, categoryOfExtension, extensionOf, type FileCategory } from "./file-categories";
import type { DriveEntry } from "./types";

type SortKey = "name" | "size" | "modified";
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
    onUpload,
    onDelete,
    onRename,
    onShare
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
    onUpload: (files: FileList | null) => void;
    onDelete: (entries: DriveEntry[]) => void;
    onRename: (entry: DriveEntry, nextName: string) => void;
    onShare: (entry: DriveEntry) => void;
}) {
    const [query, setQuery] = useState("");
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

    // Selection and rename are tied to a specific listing; drop them whenever the
    // location changes so a stale selection never leaks across folders.
    useEffect(() => {
        setSelected(new Set());
        setRenaming(null);
        lastIndex.current = null;
    }, [connectionId, path]);

    const hasFilters =
        categories.size > 0 || extFilter.trim() !== "" || minMb !== "" || maxMb !== "" || dateFrom !== "" || dateTo !== "";

    const visible = useMemo(() => {
        const min = minMb ? Number(minMb) * 1024 * 1024 : null;
        const max = maxMb ? Number(maxMb) * 1024 * 1024 : null;
        const from = dateFrom ? new Date(dateFrom).getTime() : null;
        const to = dateTo ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000 : null;
        const ext = extFilter.trim().replace(/^\./, "").toLowerCase();

        let rows = entries.filter((entry) => {
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

        const term = query.trim();
        if (term) {
            const fuse = new Fuse(rows, { keys: ["name"], threshold: 0.4, ignoreLocation: true });
            rows = fuse.search(term).map((result) => result.item);
        }

        const direction = sortDir === "asc" ? 1 : -1;
        // Folders group above files; the chosen key orders within each group.
        return [...rows].sort((a, b) => {
            const dirA = a.kind === "dir" ? 0 : 1;
            const dirB = b.kind === "dir" ? 0 : 1;
            if (dirA !== dirB) return dirA - dirB;
            if (sortKey === "size") return (Number(a.size) - Number(b.size)) * direction;
            if (sortKey === "modified") {
                return (new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()) * direction;
            }
            return a.name.localeCompare(b.name) * direction;
        });
    }, [entries, categories, extFilter, minMb, maxMb, dateFrom, dateTo, query, sortKey, sortDir]);

    const selectedEntries = visible.filter((entry) => selected.has(entry.path));
    const allSelected = visible.length > 0 && selectedEntries.length === visible.length;

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

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative min-w-[12rem] flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search this folder"
                        className="pl-8"
                    />
                </div>
                <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                    {(["name", "size", "modified"] as const).map((key) => (
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
            </div>

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
                            onClick={() =>
                                selectedEntries
                                    .filter((entry) => entry.kind !== "dir")
                                    .forEach((entry) => triggerDownload(connectionId, entry))
                            }
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

            {loading ? (
                <ListingSkeleton />
            ) : error ? (
                <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
            ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="w-9 px-3 py-2">
                                    <label className="flex cursor-pointer items-center">
                                        <Checkbox
                                            checked={allSelected}
                                            indeterminate={!allSelected && selectedEntries.length > 0}
                                            onChange={toggleAll}
                                            aria-label="Select all"
                                        />
                                    </label>
                                </th>
                                <th className="px-3 py-2 font-medium">Name</th>
                                <th className="px-3 py-2 font-medium">Size</th>
                                <th className="hidden px-3 py-2 font-medium sm:table-cell">Modified</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {visible.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                                        {entries.length === 0
                                            ? "This folder is empty."
                                            : "Nothing matches your search or filters."}
                                    </td>
                                </tr>
                            ) : (
                                visible.map((entry, index) => {
                                    const isSelected = selected.has(entry.path);
                                    const isRenaming = renaming === entry.path;
                                    return (
                                        <ContextMenu key={entry.path}>
                                            <ContextMenuTrigger asChild>
                                                <tr
                                                    className={cn(
                                                        "border-t border-border transition-colors",
                                                        isSelected ? "bg-primary/5" : "hover:bg-card-hover"
                                                    )}
                                                >
                                                    <td className="px-3 py-2">
                                                        <label className="flex cursor-pointer items-center">
                                                            <Checkbox
                                                                checked={isSelected}
                                                                onClick={(e) => handleSelectClick(e, index, entry)}
                                                                onChange={() => undefined}
                                                                aria-label={`Select ${entry.name}`}
                                                            />
                                                        </label>
                                                    </td>
                                                    <td className="px-3 py-2">
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
                                                                onClick={(e) => {
                                                                    if (e.shiftKey || e.ctrlKey || e.metaKey)
                                                                        handleSelectClick(e, index, entry);
                                                                }}
                                                                onDoubleClick={(e) => {
                                                                    e.preventDefault();
                                                                    startRename(entry);
                                                                }}
                                                                className="flex items-center gap-2 hover:text-primary"
                                                            >
                                                                <Folder className="size-4 text-primary" />
                                                                {entry.name}
                                                            </Link>
                                                        ) : (
                                                            <a
                                                                href={downloadUrl(connectionId, entry.path)}
                                                                onClick={(e) => {
                                                                    if (e.shiftKey || e.ctrlKey || e.metaKey)
                                                                        handleSelectClick(e, index, entry);
                                                                }}
                                                                onDoubleClick={(e) => {
                                                                    e.preventDefault();
                                                                    startRename(entry);
                                                                }}
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
                                                        <Button
                                                            size="icon"
                                                            variant="ghost"
                                                            onClick={() => onShare(entry)}
                                                            aria-label={`Share ${entry.name}`}
                                                        >
                                                            <Share2 className="size-4" />
                                                        </Button>
                                                    </td>
                                                </tr>
                                            </ContextMenuTrigger>
                                            <ContextMenuContent>
                                                <ContextMenuLabel>{entry.name}</ContextMenuLabel>
                                                {entry.kind === "dir" ? (
                                                    <ContextMenuItem asChild>
                                                        <Link href={href(connectionId, entry.path)}>
                                                            <Folder className="size-4" />
                                                            Open
                                                        </Link>
                                                    </ContextMenuItem>
                                                ) : (
                                                    <ContextMenuItem onSelect={() => triggerDownload(connectionId, entry)}>
                                                        <Download className="size-4" />
                                                        Download
                                                    </ContextMenuItem>
                                                )}
                                                <ContextMenuItem onSelect={() => startRename(entry)}>
                                                    <Pencil className="size-4" />
                                                    Rename
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => onShare(entry)}>
                                                    <Share2 className="size-4" />
                                                    Share
                                                </ContextMenuItem>
                                                <ContextMenuSeparator />
                                                <ContextMenuItem variant="danger" onSelect={() => onDelete([entry])}>
                                                    <Trash2 className="size-4" />
                                                    Delete
                                                </ContextMenuItem>
                                            </ContextMenuContent>
                                        </ContextMenu>
                                    );
                                })
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
