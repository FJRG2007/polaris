"use client";

/**
 * Archive preview + extract. Lists a zip/rar's contents without extracting, and
 * extracts it into a chosen folder on the NAS. A password unlocks an encrypted
 * archive (for both preview and extract). Zip-slip and decompression-bomb guards
 * live server-side in the extract action. Rendered with a per-target key so the
 * default destination resets for each archive.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderInput } from "lucide-react";
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
    const [loading, setLoading] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function loadPreview() {
        if (!target) return;
        setLoading(true);
        setError(null);
        const result = await previewArchiveAction(connectionId, target.path, password || undefined);
        setLoading(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setEntries(result.entries ?? []);
    }

    async function onExtract() {
        if (!target) return;
        setPending(true);
        setError(null);
        const result = await extractArchiveAction(connectionId, target.path, dest, password || undefined);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        router.refresh();
    }

    return (
        <Dialog open={target !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="truncate">{target?.name}</DialogTitle>
                    <DialogDescription>
                        Preview and extract this archive. Set a password if it is encrypted.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Password (if encrypted)
                        <div className="flex gap-2">
                            <Input
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                autoComplete="new-password"
                            />
                            <Button type="button" variant="secondary" onClick={loadPreview} disabled={loading}>
                                {loading ? "..." : "Preview"}
                            </Button>
                        </div>
                    </label>

                    {entries ? (
                        <div className="max-h-48 overflow-auto rounded-md border border-border text-sm">
                            {entries.length === 0 ? (
                                <p className="p-3 text-muted-foreground">Empty archive.</p>
                            ) : (
                                <ul className="divide-y divide-border">
                                    {entries.slice(0, 500).map((entry) => (
                                        <li
                                            key={entry.name}
                                            className="flex items-center justify-between gap-2 px-3 py-1.5"
                                        >
                                            <span className="truncate">{entry.name}</span>
                                            <span className="shrink-0 text-xs text-muted-foreground">
                                                {entry.isDirectory ? "folder" : formatBytes(BigInt(entry.size))}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {entries.length > 500 ? (
                                <p className="p-2 text-xs text-muted-foreground">
                                    Showing the first 500 of {entries.length} entries.
                                </p>
                            ) : null}
                        </div>
                    ) : null}

                    <label className="flex flex-col gap-1 text-sm">
                        Extract to
                        <Input value={dest} onChange={(event) => setDest(event.target.value)} placeholder="folder path" />
                    </label>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
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
                </div>
            </DialogContent>
        </Dialog>
    );
}
