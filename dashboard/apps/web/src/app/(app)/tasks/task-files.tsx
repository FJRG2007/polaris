"use client";

/**
 * The two things a task collects from outside itself: files and commits.
 *
 * Both are evidence. A screenshot of the bug and the commit that fixed it are
 * what make a closed task readable a year later, and both are things people
 * currently keep somewhere else - a chat thread, a browser tab - where they stop
 * being attached to anything.
 *
 * Uploading goes to a route rather than a server action: an action buffers the
 * whole file in memory before it runs, which is fine for a form field and not
 * fine for a phone video.
 */

import Image from "next/image";
import * as actions from "./actions";
import { useRef, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Button, Input, cn } from "@polaris/ui";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime } from "@/components/relative-time";
import type { CommitLink } from "@/lib/tasks/commit-service";
import type { AttachmentView } from "@/lib/tasks/attachment-service";
import { FileText, GitCommitHorizontal, Loader2, Paperclip, Trash2, Upload, X } from "lucide-react";

/** Bytes as a person reads them. */
function readableSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function attachmentUrl(attachmentId: string): string {
    return `/api/tasks/attachments/${attachmentId}`;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function AttachmentSection({
    taskId,
    attachments,
    canEdit,
    onChanged,
    onError
}: {
    taskId: string;
    attachments: readonly AttachmentView[];
    canEdit: boolean;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const input = useRef<HTMLInputElement | null>(null);
    const [busy, setBusy] = useState(false);
    const [dragging, setDragging] = useState(false);

    const upload = async (fileList: FileList | null) => {
        if (!fileList || fileList.length === 0) return;
        setBusy(true);
        onError("");
        for (const file of Array.from(fileList)) {
            try {
                const response = await fetch(
                    `/api/tasks/attachments?task=${encodeURIComponent(taskId)}&name=${encodeURIComponent(file.name)}`,
                    {
                        method: "POST",
                        headers: { "Content-Type": file.type || "application/octet-stream" },
                        // The File itself, not FormData: the route streams the
                        // body straight into storage, and FormData would make it
                        // a multipart document somebody has to parse in memory.
                        body: file
                    }
                );
                if (!response.ok) onError((await response.text()) || "Could not upload that file");
            } catch {
                onError("Could not upload that file");
            }
        }
        setBusy(false);
        if (input.current) input.current.value = "";
        onChanged();
    };

    const images = attachments.filter((file) => file.mime.startsWith("image/"));
    const rest = attachments.filter((file) => !file.mime.startsWith("image/"));

    return (
        <section className="flex flex-col gap-2">
            <header className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Files</h3>
                {canEdit && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => input.current?.click()}>
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
                        Attach
                    </Button>
                )}
            </header>

            <input
                ref={input}
                type="file"
                multiple
                hidden
                aria-hidden
                onChange={(event) => void upload(event.target.files)}
            />

            {canEdit && (
                <div
                    onDragOver={(event) => {
                        event.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        void upload(event.dataTransfer.files);
                    }}
                    className={cn(
                        "rounded-md border border-dashed px-3 py-4 text-center text-xs transition-colors",
                        dragging ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground"
                    )}
                >
                    <Upload className="mx-auto mb-1 size-4 opacity-60" />
                    Drop a screenshot, a recording or a document here
                </div>
            )}

            {images.length > 0 && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {images.map((file) => (
                        <figure key={file.id} className="group relative overflow-hidden rounded-md border border-border">
                            <a href={attachmentUrl(file.id)} target="_blank" rel="noreferrer">
                                <Image
                                    src={attachmentUrl(file.id)}
                                    alt={file.name}
                                    width={320}
                                    height={180}
                                    unoptimized
                                    className="h-24 w-full object-cover"
                                />
                            </a>
                            {canEdit && (
                                <button
                                    type="button"
                                    aria-label={`Remove ${file.name}`}
                                    title="Remove"
                                    onClick={async () => {
                                        await runAction(
                                            () => actions.deleteAttachmentAction(taskId, file.id),
                                            onError
                                        );
                                        onChanged();
                                    }}
                                    className="absolute right-1 top-1 rounded bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                                >
                                    <X className="size-3.5" />
                                </button>
                            )}
                        </figure>
                    ))}
                </div>
            )}

            {rest.length > 0 && (
                <ul className="divide-y divide-border rounded-md border border-border">
                    {rest.map((file) => (
                        <li key={file.id} className="group flex items-center gap-2 px-3 py-2">
                            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                            <a
                                href={attachmentUrl(file.id)}
                                target="_blank"
                                rel="noreferrer"
                                className="flex-1 truncate text-sm hover:underline"
                            >
                                {file.name}
                            </a>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                                {readableSize(file.size)}
                            </span>
                            {canEdit && (
                                <button
                                    type="button"
                                    aria-label={`Remove ${file.name}`}
                                    title="Remove"
                                    onClick={async () => {
                                        await runAction(
                                            () => actions.deleteAttachmentAction(taskId, file.id),
                                            onError
                                        );
                                        onChanged();
                                    }}
                                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {attachments.length === 0 && !canEdit && (
                <p className="text-xs text-muted-foreground">Nothing attached.</p>
            )}
        </section>
    );
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export function CommitSection({
    taskId,
    links,
    canEdit,
    onChanged,
    onError
}: {
    taskId: string;
    links: readonly CommitLink[];
    canEdit: boolean;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);

    const link = async () => {
        const reference = value.trim();
        if (!reference || busy) return;
        setBusy(true);
        onError("");
        const result = await runAction(() => actions.linkCommitAction(taskId, reference), onError);
        setBusy(false);
        if (result?.error) {
            onError(result.error);
            return;
        }
        setValue("");
        onChanged();
    };

    if (links.length === 0 && !canEdit) return null;

    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Commits</h3>

            {links.length > 0 && (
                <ul className="divide-y divide-border rounded-md border border-border">
                    {links.map((commit) => (
                        <li key={commit.id} className="group flex items-center gap-2 px-3 py-2">
                            <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                            <a
                                href={commit.url}
                                target="_blank"
                                rel="noreferrer"
                                className="min-w-0 flex-1 truncate text-sm hover:underline"
                                title={`${commit.repository}@${commit.sha}`}
                            >
                                <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                                    {commit.shortSha}
                                </span>
                                {commit.message || commit.repository}
                            </a>
                            {commit.committedAt && (
                                <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                                    <RelativeTime iso={commit.committedAt} />
                                </span>
                            )}
                            <CopyButton value={commit.url} label="the commit link" className="opacity-0 group-hover:opacity-100" />
                            {canEdit && (
                                <button
                                    type="button"
                                    aria-label={`Unlink ${commit.shortSha}`}
                                    title="Unlink"
                                    onClick={async () => {
                                        await runAction(() => actions.unlinkCommitAction(taskId, commit.id), onError);
                                        onChanged();
                                    }}
                                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                                >
                                    <X className="size-3.5" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {canEdit && (
                <div className="flex items-center gap-2">
                    <Input
                        value={value}
                        disabled={busy}
                        placeholder="Paste a commit link, or owner/repo@sha"
                        onChange={(event) => setValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void link();
                        }}
                        className="h-8 text-sm"
                    />
                    <Button size="sm" variant="ghost" disabled={busy || !value.trim()} onClick={() => void link()}>
                        Link
                    </Button>
                </div>
            )}
        </section>
    );
}
