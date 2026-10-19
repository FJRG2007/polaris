"use client";

/**
 * Attachments: the pictures and files on a message, or waiting in the
 * composer - a thumbnail for a picture, a named tile for anything else.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/attachments.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: Tailwind 3 and Polaris tokens, the grid
 * variant only, and pictures shown only from Polar's own file route (or a
 * local preview being uploaded), never from an arbitrary address.
 */

import { cn } from "@polaris/ui";
import type { HTMLAttributes } from "react";
import { FileText, Loader2, X } from "lucide-react";
import { polarAttachmentId } from "@/lib/polar/shared";

export interface AttachmentData {
    id: string;
    url: string;
    filename?: string;
    mediaType: string;
    /** Still uploading: a local preview and a spinner. */
    pending?: boolean;
}

export function Attachments({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex flex-wrap gap-2", className)} {...props} />;
}

function showable(file: AttachmentData): boolean {
    if (!file.mediaType.startsWith("image/")) return false;
    return polarAttachmentId(file.url) !== null || file.url.startsWith("blob:");
}

export function Attachment({
    file,
    removeLabel,
    onRemove
}: {
    file: AttachmentData;
    removeLabel?: string;
    onRemove?: () => void;
}) {
    const name = file.filename ?? file.mediaType;
    const body = showable(file) ? (
        <img src={file.url} alt={name} className="h-16 w-16 rounded-md border border-border object-cover" />
    ) : (
        <span className="flex h-16 w-40 min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground">
            <FileText className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate" title={name}>
                {name}
            </span>
        </span>
    );
    return (
        <div className="relative" title={name}>
            {polarAttachmentId(file.url) && !file.pending ? (
                <a href={file.url} target="_blank" rel="noreferrer">
                    {body}
                </a>
            ) : (
                body
            )}
            {file.pending ? (
                <span className="absolute inset-0 flex items-center justify-center rounded-md bg-background/60">
                    <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
                </span>
            ) : null}
            {onRemove && removeLabel ? (
                <button
                    type="button"
                    aria-label={removeLabel}
                    title={removeLabel}
                    onClick={onRemove}
                    className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-elevated text-muted-foreground hover:text-foreground"
                >
                    <X className="h-3 w-3" />
                </button>
            ) : null}
        </div>
    );
}
