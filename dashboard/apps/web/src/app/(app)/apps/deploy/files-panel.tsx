"use client";

/**
 * Minimal container file browser: list a directory, navigate into folders,
 * download a file, and upload one (host -> container). Reads/writes go through the
 * deploy fs endpoints, which the host daemon serves from a small command
 * allowlist. In-app only; no native dialogs.
 *
 * It can be rooted below "/" so a volume opens on its own contents rather than on
 * the container's filesystem. The root is a floor, not a filter: navigation never
 * climbs above it, because a panel opened on a volume that wanders into /etc is
 * showing something the operator did not ask for.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { asDirectory, parentDirectory } from "./files-path";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Download, File as FileIcon, Folder, HardDrive, Upload } from "lucide-react";

interface Entry {
    name: string;
    isDir: boolean;
}

export function FilesPanel({ applicationId, root = "/" }: { applicationId: string; root?: string }) {
    const base = asDirectory(root);
    const [path, setPath] = useState(base);
    const [entries, setEntries] = useState<Entry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    const load = useCallback(
        async (next: string) => {
            setBusy(true);
            setError(null);
            const res = await fetch(`/api/deploy/apps/${applicationId}/files?path=${encodeURIComponent(next)}`, {
                cache: "no-store"
            });
            const data = (await res.json()) as { entries?: Entry[]; error?: string };
            if (!res.ok) setError(data.error ?? "Could not list files");
            else {
                setEntries(data.entries ?? []);
                setPath(next);
            }
            setBusy(false);
        },
        [applicationId]
    );

    useEffect(() => {
        void load(base);
    }, [base, load]);

    function goUp() {
        void load(parentDirectory(path, base));
    }

    function enter(entry: Entry) {
        if (entry.isDir) void load(`${path}${entry.name}/`);
    }

    async function onUpload(file: File) {
        setBusy(true);
        setError(null);
        const res = await fetch(
            `/api/deploy/apps/${applicationId}/files?path=${encodeURIComponent(`${path}${file.name}`)}`,
            { method: "PUT", body: await file.arrayBuffer() }
        );
        if (!res.ok) {
            const data = (await res.json()) as { error?: string };
            setError(data.error ?? "Upload failed");
        } else {
            await load(path);
        }
        setBusy(false);
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={goUp} disabled={busy || path === base} title="Up" aria-label="Up">
                    <ArrowUp className="size-4" />
                </Button>
                <span className="truncate text-xs text-muted-foreground">{path}</span>
                <div className="ml-auto flex items-center gap-2">
                    <Button asChild variant="ghost" title="Open this container in Drive">
                        <Link href={`/drive?c=container:${applicationId}&p=${encodeURIComponent(path.replace(/^\/+|\/+$/g, ""))}`}>
                            <HardDrive className="size-4" /> View in Drive
                        </Link>
                    </Button>
                    <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy}>
                        <Upload className="size-4" /> Upload
                    </Button>
                    <input
                        ref={fileInput}
                        type="file"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void onUpload(file);
                            event.target.value = "";
                        }}
                    />
                </div>
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="max-h-80 overflow-auto rounded-md border border-border/60">
                {entries.length === 0 && !busy && <p className="p-3 text-xs text-muted-foreground">Empty.</p>}
                {entries.map((entry) => (
                    <div
                        key={entry.name}
                        className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5 last:border-0"
                    >
                        <button
                            className="flex items-center gap-2 text-sm hover:underline disabled:no-underline"
                            onClick={() => enter(entry)}
                            disabled={!entry.isDir}
                        >
                            {entry.isDir ? (
                                <Folder className="size-4 text-sky-400" />
                            ) : (
                                <FileIcon className="size-4 text-muted-foreground" />
                            )}
                            {entry.name}
                        </button>
                        {!entry.isDir && (
                            <a
                                href={`/api/deploy/apps/${applicationId}/files/download?path=${encodeURIComponent(`${path}${entry.name}`)}`}
                                className="text-muted-foreground hover:text-foreground"
                                title="Download"
                            >
                                <Download className="size-4" />
                            </a>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
