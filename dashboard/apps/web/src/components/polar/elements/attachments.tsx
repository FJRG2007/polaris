"use client";

/**
 * Attachments: the pictures and files on a message, or waiting in the
 * composer - drawn the way Polaris Chat draws them. A picture is a thumbnail
 * that opens in the shared image viewer (arrows through the others beside
 * it); anything else is Chat's file chip: an icon for its type, the name cut
 * short with the whole of it on hover, and its size. In the composer each one
 * also shows how far its upload has got, and a failed one keeps its place
 * with a retry.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/attachments.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: Tailwind 3 and Polaris tokens, Chat's
 * thumbnail and chip, and pictures shown only from Polar's own file route (or
 * a local preview of a file in this browser), never from an arbitrary address.
 */

import { cn } from "@polaris/ui";
import { formatBytes } from "@polaris/core";
import { useState, type HTMLAttributes } from "react";
import { polarAttachmentId } from "@/lib/polar/shared";
import { fileIconFor } from "@/app/(app)/drive/file-icons";
import { AlertCircle, Loader2, RotateCcw, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ImageViewer, type ViewedImage } from "@/components/image-viewer";

export interface AttachmentData {
    id: string;
    /** Polar's own address for it, or "" while it has none yet. */
    url: string;
    filename?: string;
    mediaType: string;
    /** Bytes, when known: always in the composer, on a message when it was sent with it. */
    size?: number;
    /** Still uploading. */
    pending?: boolean;
    /** How much of the upload has gone, 0 to 1. */
    progress?: number;
    /** Why the upload failed, in a sentence; the file stays for a retry. */
    failed?: string;
    /** A local object address for a picture picked in this browser. */
    preview?: string;
}

/** The formats drawn as a picture - the same list Chat draws inline, because
 *  they are pictures and cannot carry script. An SVG is deliberately not one. */
const PICTURES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Where a picture can be drawn from, or null when it is drawn as a chip. */
export function pictureUrl(file: AttachmentData): string | null {
    if (!PICTURES.has(file.mediaType.split(";")[0]?.trim().toLowerCase() ?? "")) return null;
    if (file.preview?.startsWith("blob:")) return file.preview;
    return polarAttachmentId(file.url) !== null ? file.url : null;
}

export function Attachments({ className, ...props }: HTMLAttributes<HTMLUListElement>) {
    return <ul className={cn("flex flex-wrap items-end gap-2", className)} {...props} />;
}

/**
 * A row of attachments with the viewer that opens their pictures: what both
 * the composer and a sent message draw.
 */
export function AttachmentList({
    files,
    className,
    onRemove,
    onRetry
}: {
    files: readonly AttachmentData[];
    className?: string;
    /** Given in the composer only. */
    onRemove?: (file: AttachmentData) => void;
    onRetry?: (file: AttachmentData) => void;
}) {
    const [viewing, setViewing] = useState<ViewedImage | null>(null);
    const gallery = files.flatMap((file) => {
        const url = pictureUrl(file);
        return url ? [{ url, name: file.filename ?? file.mediaType }] : [];
    });
    if (files.length === 0) return null;
    return (
        <>
            <Attachments className={className}>
                {files.map((file) => (
                    <Attachment
                        key={file.id}
                        file={file}
                        onOpen={(image) => setViewing(image)}
                        onRemove={onRemove ? () => onRemove(file) : undefined}
                        onRetry={onRetry ? () => onRetry(file) : undefined}
                    />
                ))}
            </Attachments>
            <ImageViewer
                image={viewing}
                gallery={gallery}
                onNavigate={setViewing}
                onClose={() => setViewing(null)}
            />
        </>
    );
}

export function Attachment({
    file,
    onOpen,
    onRemove,
    onRetry
}: {
    file: AttachmentData;
    onOpen?: (image: ViewedImage) => void;
    onRemove?: () => void;
    onRetry?: () => void;
}) {
    const t = useTranslations("polar");
    const name = file.filename ?? file.mediaType;
    const picture = pictureUrl(file);
    const percent = Math.floor(Math.min(1, Math.max(0, file.progress ?? 0)) * 100);
    const size = file.size !== undefined ? formatBytes(file.size) : null;

    const remove = onRemove ? (
        <button
            type="button"
            aria-label={t("files.remove", { name })}
            title={t("files.remove", { name })}
            onClick={onRemove}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
            <X className="size-3" />
        </button>
    ) : null;
    const retry =
        file.failed && onRetry ? (
            <button
                type="button"
                aria-label={t("files.retry", { name })}
                title={t("files.retry", { name })}
                onClick={onRetry}
                className="rounded p-0.5 text-danger-ink transition-colors hover:text-foreground"
            >
                <RotateCcw className="size-3" />
            </button>
        ) : null;
    const state = file.pending ? (
        <span className="sr-only" role="status">
            {t("files.uploading", { name, percent })}
        </span>
    ) : null;

    if (picture) {
        return (
            <li className="relative" title={file.failed ?? (size ? `${name} - ${size}` : name)}>
                <button
                    type="button"
                    onClick={() => onOpen?.({ url: picture, name })}
                    aria-label={t("files.open", { name })}
                    className={cn(
                        "block size-20 cursor-zoom-in overflow-hidden rounded-md border",
                        file.failed ? "border-danger" : "border-border"
                    )}
                >
                    <img src={picture} alt={name} className="size-full object-cover" />
                </button>
                {file.pending ? (
                    <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-md bg-background/60 text-xs font-medium tabular-nums">
                        <Loader2 className="size-4 motion-safe:animate-spin" />
                        {percent}%
                    </span>
                ) : null}
                {file.failed ? (
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/60 text-danger-ink">
                        <AlertCircle className="size-5" />
                    </span>
                ) : null}
                {remove || retry ? (
                    <span className="absolute -right-1.5 -top-1.5 flex items-center gap-0.5 rounded-full border border-border bg-elevated px-0.5 shadow-sm">
                        {retry}
                        {remove}
                    </span>
                ) : null}
                {state}
            </li>
        );
    }

    const { icon: Icon, className: tint } = fileIconFor(name);
    const chip = (
        <>
            {file.failed ? (
                <AlertCircle className="size-3.5 shrink-0 text-danger-ink" />
            ) : (
                <Icon className={cn("size-3.5 shrink-0", tint)} />
            )}
            <span className="min-w-0 max-w-[12rem] truncate" title={name}>
                {name}
            </span>
            {file.pending ? (
                <span className="shrink-0 tabular-nums text-muted-foreground">{percent}%</span>
            ) : size ? (
                <span className="shrink-0 text-muted-foreground">{size}</span>
            ) : null}
        </>
    );
    const link = polarAttachmentId(file.url) !== null && !file.pending && !onRemove;
    return (
        <li
            title={file.failed}
            className={cn(
                "relative flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md border bg-card px-2 py-1 text-xs",
                file.failed ? "border-danger" : "border-border",
                link && "transition-colors hover:bg-card-hover"
            )}
        >
            {link ? (
                <a
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 items-center gap-1.5"
                >
                    {chip}
                </a>
            ) : (
                chip
            )}
            {retry}
            {remove}
            {file.pending ? (
                <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-[width]"
                    style={{ width: `${percent}%` }}
                />
            ) : null}
            {state}
        </li>
    );
}
