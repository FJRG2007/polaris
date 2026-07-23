"use client";

/**
 * Archive browser + extract. On open it lists a zip/rar's contents without
 * extracting and lets you navigate into folders like a real filesystem (folders
 * are inferred from entry paths, so archives without explicit directory records
 * still navigate). A password box appears only when it's actually needed - when
 * reading or extracting fails - and unlocks an encrypted archive for both. Extract
 * writes into a chosen folder, defaulting to the current one. Zip-slip and
 * decompression-bomb guards live server-side in the extract action. Rendered with
 * a per-target key so state resets for each archive.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, File as FileIcon, Folder, FolderInput, Loader2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import type { DriveEntry } from "./types";
import { extractArchiveAction, previewArchiveAction } from "./actions";

interface Listed {
    name: string;
    size: number;
    isDirectory: boolean;
}

interface Level {
    folders: string[];
    files: { name: string; size: number }[];
}

/** How many rows to render at one level before truncating the list. */
const MAX_ROWS = 1000;

/** Strip Windows separators, a leading "./", and any trailing slash. */
function normalizeEntry(name: string): string {
    return name.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Immediate children of `cwd` within the archive, derived from the flat entry
 * list. Folders are inferred from entry paths even when the archive carries no
 * explicit directory records, so navigation works like a real filesystem.
 */
function childrenAt(entries: Listed[], cwd: string): Level {
    const prefix = cwd ? `${cwd}/` : "";
    const folders = new Set<string>();
    const files = new Map<string, number>();
    for (const entry of entries) {
        const full = normalizeEntry(entry.name);
        if (!full || (prefix && !full.startsWith(prefix))) continue;
        const rest = full.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf("/");
        if (slash === -1) {
            if (entry.isDirectory) folders.add(rest);
            else files.set(rest, entry.size);
        } else {
            folders.add(rest.slice(0, slash));
        }
    }
    return {
        folders: [...folders].sort((a, b) => a.localeCompare(b)),
        files: [...files]
            .map(([name, size]) => ({ name, size }))
            .sort((a, b) => a.name.localeCompare(b.name))
    };
}

export function ArchiveDialog({
    connectionId,
    target,
    currentPath,
    onOpenChange
}: {
    connectionId: string;
    target: DriveEntry | null;
    currentPath: string;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const base = target ? target.name.replace(/\.(zip|rar)$/i, "") : "";
    const [password, setPassword] = useState("");
    const [dest, setDest] = useState(currentPath ? `${currentPath}/${base}` : base);
    const [entries, setEntries] = useState<Listed[] | null>(null);
    const [cwd, setCwd] = useState("");
    const [loading, setLoading] = useState(false);
    const [pending, setPending] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [extractError, setExtractError] = useState<string | null>(null);

    async function loadPreview() {
        if (!target) return;
        setLoading(true);
        setPreviewError(null);
        const result = await previewArchiveAction(connectionId, target.path, password || undefined);
        setLoading(false);
        if (result.error) {
            setPreviewError(result.error);
            setEntries(null);
            return;
        }
        setEntries(result.entries ?? []);
        setCwd("");
    }

    // Read the archive as soon as it opens (no password). The dialog is re-keyed
    // per target, so this runs once for each archive.
    useEffect(() => {
        void loadPreview();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function onExtract() {
        if (!target) return;
        setPending(true);
        setExtractError(null);
        const result = await extractArchiveAction(
            connectionId,
            target.path,
            dest,
            password || undefined
        );
        setPending(false);
        if (result.error) {
            setExtractError(result.error);
            return;
        }
        onOpenChange(false);
        router.refresh();
    }

    const level = useMemo(() => (entries ? childrenAt(entries, cwd) : null), [entries, cwd]);
    const crumbs = cwd ? cwd.split("/") : [];
    const shownFiles = level ? level.files.slice(0, MAX_ROWS) : [];
    const hiddenFiles = level ? level.files.length - shownFiles.length : 0;

    return (
        <Dialog open={target !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="truncate">{target?.name}</DialogTitle>
                    <DialogDescription>
                        Browse the contents without extracting, or extract into a folder.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    {loading && entries === null && !previewError ? (
                        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            Reading archive...
                        </div>
                    ) : null}

                    {previewError && entries === null ? (
                        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                            <p className="text-sm">
                                Couldn&apos;t read this archive. If it&apos;s password-protected,
                                enter the password to view its contents.
                            </p>
                            <div className="flex gap-2">
                                <Input
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                    onKeyDown={(event) => event.key === "Enter" && loadPreview()}
                                    placeholder="Password"
                                    autoComplete="new-password"
                                />
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={loadPreview}
                                    disabled={loading}
                                >
                                    {loading ? "..." : "Unlock"}
                                </Button>
                            </div>
                            <p className="text-xs text-danger">{previewError}</p>
                        </div>
                    ) : null}

                    {entries !== null && level ? (
                        <div className="rounded-md border border-border">
                            <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs">
                                <button
                                    type="button"
                                    onClick={() => setCwd("")}
                                    className="max-w-40 truncate hover:underline"
                                >
                                    {target?.name}
                                </button>
                                {crumbs.map((segment, index) => (
                                    <span key={index} className="flex items-center gap-1">
                                        <ChevronRight className="size-3 text-muted-foreground" />
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setCwd(crumbs.slice(0, index + 1).join("/"))
                                            }
                                            className="hover:underline"
                                        >
                                            {segment}
                                        </button>
                                    </span>
                                ))}
                            </div>
                            <div className="max-h-64 overflow-auto">
                                {level.folders.length === 0 && level.files.length === 0 ? (
                                    <p className="p-3 text-sm text-muted-foreground">
                                        Empty folder.
                                    </p>
                                ) : (
                                    <ul className="divide-y divide-border text-sm">
                                        {level.folders.map((folder) => (
                                            <li key={`d:${folder}`}>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setCwd(cwd ? `${cwd}/${folder}` : folder)
                                                    }
                                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
                                                >
                                                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                                                    <span className="truncate">{folder}</span>
                                                </button>
                                            </li>
                                        ))}
                                        {shownFiles.map((file) => (
                                            <li
                                                key={`f:${file.name}`}
                                                className="flex items-center justify-between gap-2 px-3 py-1.5"
                                            >
                                                <span className="flex min-w-0 items-center gap-2">
                                                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                                    <span className="truncate">{file.name}</span>
                                                </span>
                                                <span className="shrink-0 text-xs text-muted-foreground">
                                                    {formatBytes(BigInt(file.size))}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {hiddenFiles > 0 ? (
                                    <p className="p-2 text-xs text-muted-foreground">
                                        And {hiddenFiles} more file{hiddenFiles === 1 ? "" : "s"} in
                                        this folder.
                                    </p>
                                ) : null}
                            </div>
                        </div>
                    ) : null}

                    {entries !== null ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Extract to
                                <Input
                                    value={dest}
                                    onChange={(event) => setDest(event.target.value)}
                                    placeholder="folder path"
                                />
                            </label>
                            {extractError ? (
                                <div className="flex flex-col gap-1">
                                    <p className="text-sm text-danger">{extractError}</p>
                                    <Input
                                        type="password"
                                        value={password}
                                        onChange={(event) => setPassword(event.target.value)}
                                        placeholder="Password (if encrypted)"
                                        autoComplete="new-password"
                                    />
                                </div>
                            ) : null}
                            <div className="mt-1 flex justify-end gap-2">
                                <DialogClose asChild>
                                    <Button type="button" variant="ghost">
                                        Close
                                    </Button>
                                </DialogClose>
                                <Button type="button" onClick={onExtract} disabled={pending}>
                                    <FolderInput className="size-4" />
                                    {pending ? "Extracting..." : "Extract"}
                                </Button>
                            </div>
                        </>
                    ) : (
                        <div className="mt-1 flex justify-end">
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    Close
                                </Button>
                            </DialogClose>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
