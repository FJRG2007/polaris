"use client";

/**
 * Drop-point uploader. Sends each selected file to the request's upload route one
 * at a time (a streaming PUT, so large files never buffer in the page), and shows
 * per-file progress and a clear reason when the server rejects one. Client-side
 * checks (extension, size) are a courtesy for fast feedback only; the route
 * re-enforces every limit, so a crafted request cannot bypass them.
 */

import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Button } from "@polaris/ui";

type ItemStatus = "pending" | "uploading" | "done" | "error";

interface Item {
    file: File;
    status: ItemStatus;
    message?: string;
}

/** Map a rejection status/body to a short human explanation. */
function explain(status: number, body: string): string {
    if (status === 413 || body === "too_large") return "Too large";
    if (status === 422 && body === "extension") return "File type not allowed";
    if (status === 422 && body === "size") return "Too large";
    if (status === 422 && body === "file_rejected") return "Blocked by security scan";
    if (status === 409 || body === "full") return "This drop point is full";
    if (status === 401) return "Sign-in required";
    if (status === 403) return "Not allowed from your network";
    if (status === 410) return "This drop point is closed";
    return "Upload failed";
}

export function DropUploader({
    token,
    allowedExtensions,
    maxSizeBytes
}: {
    token: string;
    allowedExtensions: string[];
    maxSizeBytes: number;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [items, setItems] = useState<Item[]>([]);
    const [busy, setBusy] = useState(false);

    const accept = allowedExtensions.length > 0 ? allowedExtensions.map((extension) => `.${extension}`).join(",") : undefined;

    function localReason(file: File): string | null {
        if (file.size > maxSizeBytes) return "Too large";
        if (allowedExtensions.length > 0) {
            const dot = file.name.lastIndexOf(".");
            const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
            if (!allowedExtensions.includes(extension)) return "File type not allowed";
        }
        return null;
    }

    async function upload(file: File): Promise<Item> {
        const rejected = localReason(file);
        if (rejected) return { file, status: "error", message: rejected };
        try {
            const res = await fetch(`/api/r/${token}/upload?name=${encodeURIComponent(file.name)}`, {
                method: "PUT",
                body: file
            });
            if (!res.ok) return { file, status: "error", message: explain(res.status, (await res.text()).trim()) };
            return { file, status: "done" };
        } catch {
            return { file, status: "error", message: "Upload failed" };
        }
    }

    async function onFiles(fileList: FileList | null) {
        if (!fileList || fileList.length === 0) return;
        const files = Array.from(fileList);
        setBusy(true);
        setItems(files.map((file) => ({ file, status: "uploading" })));
        const results: Item[] = [];
        for (const file of files) {
            const result = await upload(file);
            results.push(result);
            setItems([...results, ...files.slice(results.length).map((f) => ({ file: f, status: "uploading" as const }))]);
        }
        setItems(results);
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
    }

    return (
        <div className="flex flex-col gap-3">
            <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-surface/40 p-8 text-center text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-60"
            >
                <UploadCloud className="size-8" />
                <span className="font-medium">Choose files to upload</span>
                <span className="text-xs">Up to {formatBytes(BigInt(maxSizeBytes))} each</span>
            </button>
            <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                accept={accept}
                onChange={(event) => onFiles(event.target.files)}
            />

            {items.length > 0 ? (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {items.map((item, index) => (
                        <li key={`${item.file.name}-${index}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                            {item.status === "done" ? (
                                <CheckCircle2 className="size-4 shrink-0 text-success" />
                            ) : item.status === "error" ? (
                                <AlertCircle className="size-4 shrink-0 text-danger" />
                            ) : (
                                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{item.file.name}</span>
                            <span
                                className={
                                    item.status === "error" ? "text-xs text-danger" : "text-xs text-muted-foreground"
                                }
                            >
                                {item.status === "error" ? item.message : formatBytes(BigInt(item.file.size))}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}

            {items.length > 0 && !busy ? (
                <Button type="button" variant="ghost" onClick={() => setItems([])} className="self-start">
                    Upload more
                </Button>
            ) : null}
        </div>
    );
}
