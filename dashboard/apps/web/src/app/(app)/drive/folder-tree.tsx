"use client";

/**
 * Folder tree for picking a destination path inside one connection. Branches load
 * lazily (a folder's children are fetched the first time it is expanded) and stay
 * cached for the life of the dialog, so browsing a deep tree never re-hits the NAS
 * for a folder that was already opened. Only directories are shown - the picker
 * exists to choose a location, never a file.
 *
 * Branches come from the same listing cache the file view fills, so a folder just
 * browsed opens here without a request - and one opened here is already paid for if
 * the move lands in it.
 */

import { cn } from "@polaris/ui";
import type { DriveEntry } from "./types";
import { readListing, writeListing } from "./listing-cache";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Loader2, Lock } from "lucide-react";

interface FolderNode {
    name: string;
    path: string;
    /** The folder is access-gated, so its contents cannot be listed from here. */
    locked: boolean;
}

/** Every ancestor of a path, root first ("a/b/c" -> ["", "a", "a/b"]). */
function ancestorsOf(path: string): string[] {
    const segments = path.split("/").filter(Boolean);
    const out = [""];
    for (let index = 0; index < segments.length - 1; index++) {
        out.push(segments.slice(0, index + 1).join("/"));
    }
    return out;
}

export function FolderTree({
    connectionId,
    value,
    onChange,
    rootLabel = "Home",
    className
}: {
    connectionId: string;
    /** Currently picked folder ("" is the connection root). */
    value: string;
    onChange: (path: string) => void;
    rootLabel?: string;
    className?: string;
}) {
    const [children, setChildren] = useState<Record<string, FolderNode[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
    const [loading, setLoading] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    // Folders already requested, so an expand/collapse cycle does not refetch.
    const requested = useRef<Set<string>>(new Set());

    /** The directories of a listing, as the tree shows them. */
    const branchOf = useCallback(
        (entries: DriveEntry[]): FolderNode[] =>
            entries
                .filter((entry) => entry.kind === "dir")
                .map((entry) => ({ name: entry.name, path: entry.path, locked: Boolean(entry.locked) }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        []
    );

    const load = useCallback(
        async (path: string) => {
            if (requested.current.has(path)) return;
            requested.current.add(path);
            const cached = readListing(connectionId, path);
            if (cached) {
                setChildren((prev) => ({ ...prev, [path]: branchOf(cached) }));
                return;
            }
            setLoading((prev) => new Set(prev).add(path));
            try {
                const query = new URLSearchParams({ c: connectionId });
                if (path) query.set("p", path);
                const response = await fetch(`/api/drive/list?${query.toString()}`);
                const body = await response.json();
                if (!response.ok || body.error) {
                    // A locked or unreadable branch is not a dialog-level failure:
                    // it simply has no children to offer.
                    if (path === "") setError(body.error ?? "Could not list this connection");
                    setChildren((prev) => ({ ...prev, [path]: [] }));
                    return;
                }
                const entries: DriveEntry[] = Array.isArray(body.entries) ? body.entries : [];
                writeListing(connectionId, path, entries);
                setChildren((prev) => ({ ...prev, [path]: branchOf(entries) }));
            } catch {
                setChildren((prev) => ({ ...prev, [path]: [] }));
                if (path === "") setError("Could not list this connection");
            } finally {
                setLoading((prev) => {
                    const next = new Set(prev);
                    next.delete(path);
                    return next;
                });
            }
        },
        [connectionId, branchOf]
    );

    // Open the tree down to the pre-selected folder so the picker starts where the
    // user already is instead of at a collapsed root.
    useEffect(() => {
        requested.current = new Set();
        setChildren({});
        setError(null);
        const ancestors = ancestorsOf(value);
        setExpanded(new Set(value ? [...ancestors, value] : ancestors));
        for (const folder of ancestors) void load(folder);
        if (value) void load(value);
        // Only re-seed when the connection changes; `value` then moves with clicks.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectionId, load]);

    function toggle(path: string) {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else {
                next.add(path);
                void load(path);
            }
            return next;
        });
    }

    function renderBranch(path: string, depth: number) {
        const nodes = children[path];
        if (!expanded.has(path)) return null;
        if (!nodes) {
            return loading.has(path) ? (
                <p
                    className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
                    style={{ paddingLeft: `${depth * 1.1 + 1.5}rem` }}
                >
                    <Loader2 className="size-3 animate-spin" />
                    Loading...
                </p>
            ) : null;
        }
        if (nodes.length === 0) return null;
        return nodes.map((node) => (
            <div key={node.path}>
                <div
                    className={cn(
                        "flex items-center gap-1 rounded-md pr-2 transition-colors",
                        value === node.path ? "bg-primary/10 text-primary" : "hover:bg-muted"
                    )}
                    style={{ paddingLeft: `${depth * 1.1}rem` }}
                >
                    <button
                        type="button"
                        onClick={() => toggle(node.path)}
                        disabled={node.locked}
                        aria-label={expanded.has(node.path) ? "Collapse" : "Expand"}
                        className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    >
                        <ChevronRight
                            className={cn(
                                "size-3.5 transition-transform",
                                expanded.has(node.path) && "rotate-90"
                            )}
                        />
                    </button>
                    <button
                        type="button"
                        onClick={() => onChange(node.path)}
                        onDoubleClick={() => toggle(node.path)}
                        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm"
                    >
                        {expanded.has(node.path) ? (
                            <FolderOpen className="size-4 shrink-0 text-primary" />
                        ) : (
                            <Folder className="size-4 shrink-0 text-primary" />
                        )}
                        <span className="truncate">{node.name}</span>
                        {node.locked ? (
                            <Lock className="size-3 shrink-0 text-muted-foreground" />
                        ) : null}
                    </button>
                </div>
                {renderBranch(node.path, depth + 1)}
            </div>
        ));
    }

    return (
        <div
            className={cn(
                "overflow-auto rounded-md border border-border bg-surface/40 p-1",
                className
            )}
        >
            <div
                className={cn(
                    "flex items-center gap-1 rounded-md pr-2 transition-colors",
                    value === "" ? "bg-primary/10 text-primary" : "hover:bg-muted"
                )}
            >
                <button
                    type="button"
                    onClick={() => toggle("")}
                    aria-label={expanded.has("") ? "Collapse" : "Expand"}
                    className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ChevronRight
                        className={cn(
                            "size-3.5 transition-transform",
                            expanded.has("") && "rotate-90"
                        )}
                    />
                </button>
                <button
                    type="button"
                    onClick={() => onChange("")}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm"
                >
                    <FolderOpen className="size-4 shrink-0 text-primary" />
                    <span className="truncate">{rootLabel}</span>
                </button>
            </div>
            {renderBranch("", 1)}
            {error ? <p className="px-2 py-1 text-xs text-danger">{error}</p> : null}
        </div>
    );
}
