"use client";

/**
 * Drop-point uploader. Sends each selected file to the request's upload route one
 * at a time (a streaming PUT, so large files never buffer in the page), and shows
 * per-file progress and a clear reason when the server rejects one. Client-side
 * checks (extension, size) are a courtesy for fast feedback only; the route
 * re-enforces every limit, so a crafted request cannot bypass them. When the drop
 * point permits it, each upload returns a private delete token (kept in this
 * browser) so the uploader can remove their own files - subject to the owner's
 * time window, which the server enforces.
 */

import { Button, cn } from "@polaris/ui";
import { formatBytes } from "@polaris/core";
import { gatherDropItems } from "@/lib/drop-items";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Trash2, UploadCloud } from "lucide-react";

type ItemStatus = "pending" | "uploading" | "done" | "error";

interface Item {
    file: File;
    status: ItemStatus;
    message?: string;
}

/** A file this browser uploaded, with the token that authorizes deleting it. */
interface MyUpload {
    id: string;
    name: string;
    deleteToken: string;
    at: number;
}

/** Map a rejection status/body to a short human explanation. */
function explain(t: NamespaceTranslator<"publicPages">, status: number, body: string): string {
    if (status === 413 || body === "too_large") return t("dropPoint.reasons.tooLarge");
    if (status === 422 && body === "extension") return t("dropPoint.reasons.type");
    if (status === 422 && body === "denied") return t("dropPoint.reasons.type");
    if (status === 422 && body === "size") return t("dropPoint.reasons.tooLarge");
    if (status === 422 && body === "too_small") return t("dropPoint.reasons.tooSmall");
    if (status === 422 && body === "file_rejected") return t("dropPoint.reasons.blocked");
    if (status === 409 || body === "full") return t("dropPoint.reasons.full");
    if (status === 403 && body === "user_not_allowed") return t("dropPoint.reasons.account");
    if (status === 403 && body === "scheduled") return t("dropPoint.reasons.notOpen");
    if (status === 401) return t("dropPoint.reasons.signIn");
    if (status === 403 && body === "country_not_allowed") return t("dropPoint.reasons.location");
    if (status === 403) return t("dropPoint.reasons.network");
    if (status === 410) return t("dropPoint.reasons.closed");
    return t("dropPoint.reasons.failed");
}

export function DropUploader({
    token,
    allowedExtensions,
    deniedExtensions,
    maxSizeBytes,
    minSizeBytes,
    allowUploaderDelete,
    deleteWindowSeconds
}: {
    token: string;
    allowedExtensions: string[];
    deniedExtensions: string[];
    maxSizeBytes: number;
    minSizeBytes: number;
    allowUploaderDelete: boolean;
    deleteWindowSeconds: number | null;
}) {
    const t = useTranslations("publicPages");
    const inputRef = useRef<HTMLInputElement>(null);
    const [items, setItems] = useState<Item[]>([]);
    const [dragging, setDragging] = useState(false);
    const [busy, setBusy] = useState(false);
    const [mine, setMine] = useState<MyUpload[]>([]);
    const [now, setNow] = useState(0);

    const storageKey = `polaris_drop_up_${token}`;

    // Restore this browser's uploads and tick a clock so delete buttons disappear
    // once their window closes (the server enforces the window regardless).
    useEffect(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (raw) setMine(JSON.parse(raw) as MyUpload[]);
        } catch {
            // Ignore unreadable/legacy storage.
        }
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    function persist(next: MyUpload[]) {
        setMine(next);
        try {
            localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
            // Storage may be unavailable (private mode); deletion still works this session.
        }
    }

    const accept =
        allowedExtensions.length > 0
            ? allowedExtensions.map((extension) => `.${extension}`).join(",")
            : undefined;

    function localReason(file: File): string | null {
        if (file.size > maxSizeBytes) return t("dropPoint.reasons.tooLarge");
        if (minSizeBytes > 0 && file.size < minSizeBytes) return t("dropPoint.reasons.tooSmall");
        const dot = file.name.lastIndexOf(".");
        const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
        if (deniedExtensions.includes(extension)) return t("dropPoint.reasons.type");
        if (allowedExtensions.length > 0 && !allowedExtensions.includes(extension)) {
            return t("dropPoint.reasons.type");
        }
        return null;
    }

    async function upload(file: File): Promise<{ item: Item; mine?: MyUpload }> {
        const rejected = localReason(file);
        if (rejected) return { item: { file, status: "error", message: rejected } };
        try {
            const res = await fetch(
                `/api/r/${token}/upload?name=${encodeURIComponent(file.name)}`,
                {
                    method: "PUT",
                    body: file
                }
            );
            if (!res.ok) {
                return {
                    item: {
                        file,
                        status: "error",
                        message: explain(t, res.status, (await res.text()).trim())
                    }
                };
            }
            const body = (await res.json()) as { id?: string; name?: string; deleteToken?: string };
            // Always the name this uploader sent. A drop point shows nobody what else
            // is in the folder, so reporting a numbered name would tell them their
            // filename was taken - which is telling them somebody else's file is there.
            const storedName = body.name ?? file.name;
            const record =
                body.id && body.deleteToken
                    ? {
                          id: body.id,
                          name: storedName,
                          deleteToken: body.deleteToken,
                          at: Date.now()
                      }
                    : undefined;
            return { item: { file, status: "done" }, mine: record };
        } catch {
            return { item: { file, status: "error", message: t("dropPoint.reasons.failed") } };
        }
    }

    async function onFiles(files: File[]) {
        if (files.length === 0) return;
        setBusy(true);
        setItems(files.map((file) => ({ file, status: "uploading" })));
        const results: Item[] = [];
        const added: MyUpload[] = [];
        for (const file of files) {
            const { item, mine: record } = await upload(file);
            results.push(item);
            if (record) added.push(record);
            setItems([
                ...results,
                ...files
                    .slice(results.length)
                    .map((f) => ({ file: f, status: "uploading" as const }))
            ]);
        }
        setItems(results);
        if (added.length > 0) persist([...added, ...mine]);
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
    }

    /**
     * Files dragged in from a file manager. A dropped FOLDER is walked rather than
     * read off `dataTransfer.files`, where it arrives as a single zero-length entry
     * that would upload as an empty file named after the folder. What lands here is
     * flat: the route stores each file under its own name, so sending a folder
     * sends what is in it, however deep.
     */
    function onDrop(event: React.DragEvent) {
        if (busy || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        // Read synchronously: the transfer is emptied once this handler returns.
        const transfer = event.dataTransfer;
        void gatherDropItems(transfer).then((dropped) => onFiles(dropped.map((item) => item.file)));
    }

    function onDragOver(event: React.DragEvent) {
        if (busy || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
    }

    async function onDelete(entry: MyUpload) {
        try {
            const res = await fetch(`/api/r/${token}/submission/${entry.id}`, {
                method: "DELETE",
                headers: { "x-delete-token": entry.deleteToken }
            });
            if (res.ok || res.status === 404) persist(mine.filter((row) => row.id !== entry.id));
        } catch {
            // Leave the entry; the user can retry.
        }
    }

    /** Whether the owner's policy still permits deleting a given upload right now. */
    function canDelete(entry: MyUpload): boolean {
        if (!allowUploaderDelete) return false;
        if (deleteWindowSeconds === null) return true;
        return (now - entry.at) / 1000 <= deleteWindowSeconds;
    }

    return (
        <div className="flex flex-col gap-3">
            <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={onDragOver}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                disabled={busy}
                className={cn(
                    "flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm transition-colors disabled:opacity-60",
                    dragging
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border bg-surface/40 text-muted-foreground hover:border-primary hover:text-foreground"
                )}
            >
                <UploadCloud className="size-8" />
                <span className="font-medium">{t("dropPoint.dropHere")}</span>
                <span className="text-xs">{t("dropPoint.upTo", { size: formatBytes(BigInt(maxSizeBytes)) })}</span>
            </button>
            <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                accept={accept}
                onChange={(event) => onFiles(event.target.files ? Array.from(event.target.files) : [])}
            />

            {items.length > 0 ? (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {items.map((item, index) => (
                        <li
                            key={`${item.file.name}-${index}`}
                            className="flex items-center gap-3 px-3 py-2 text-sm"
                        >
                            {item.status === "done" ? (
                                <CheckCircle2 className="size-4 shrink-0 text-success" />
                            ) : item.status === "error" ? (
                                <AlertCircle className="size-4 shrink-0 text-danger" />
                            ) : (
                                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1 truncate" title={item.file.name}>
                                {item.file.name}
                            </span>
                            <span
                                className={
                                    item.status === "error"
                                        ? "text-xs text-danger"
                                        : "text-xs text-muted-foreground"
                                }
                            >
                                {item.status === "error"
                                    ? item.message
                                    : formatBytes(BigInt(item.file.size))}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}

            {items.length > 0 && !busy ? (
                <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setItems([])}
                    className="self-start"
                >
                    {t("dropPoint.uploadMore")}
                </Button>
            ) : null}

            {mine.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t("dropPoint.yourUploads")}
                    </p>
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {mine.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex items-center gap-3 px-3 py-2 text-sm"
                            >
                                <CheckCircle2 className="size-4 shrink-0 text-success" />
                                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                                {canDelete(entry) ? (
                                    <button
                                        type="button"
                                        onClick={() => onDelete(entry)}
                                        className="flex items-center gap-1 text-xs text-danger hover:underline"
                                    >
                                        <Trash2 className="size-3.5" />
                                        {t("dropPoint.delete")}
                                    </button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}
