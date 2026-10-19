"use client";

/**
 * The pieces a staged or sent attachment is drawn from: the picture thumbnail
 * that opens in the image viewer, the small icon buttons beside a file, and the
 * pill in a thumbnail's corner that holds them. Chat's composer and Polar both
 * draw their attachments from these, so the two read as one product.
 */

import { cn } from "@polaris/ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/** The formats drawn as a picture rather than as a name: images that cannot
 *  carry script, which is why an SVG is deliberately not one. */
const INLINE_PICTURES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif"
]);

export function isInlinePicture(mediaType: string): boolean {
    return INLINE_PICTURES.has(mediaType.split(";")[0]?.trim().toLowerCase() ?? "");
}

/** A small icon button on an attachment: remove, retry, cover. */
export function AttachmentAction({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            type="button"
            className={cn(
                "rounded p-0.5 transition-colors",
                className ?? "text-muted-foreground hover:text-foreground"
            )}
            {...props}
        />
    );
}

/** The pill in a thumbnail's top-right corner that holds its actions. */
export function AttachmentCorner({ children }: { children: ReactNode }) {
    return (
        <span className="absolute -right-1.5 -top-1.5 flex items-center gap-0.5 rounded-full border border-border bg-elevated px-0.5 shadow-sm">
            {children}
        </span>
    );
}

/** A picture's thumbnail: a button that opens it in the viewer. */
export const AttachmentThumbnail = forwardRef<
    HTMLButtonElement,
    {
        src: string;
        name: string;
        label: string;
        onOpen: () => void;
        failed?: boolean;
        imageTitle?: string;
        imageClassName?: string;
    }
>(function AttachmentThumbnail(
    { src, name, label, onOpen, failed, imageTitle, imageClassName },
    ref
) {
    return (
        <button
            ref={ref}
            type="button"
            onClick={onOpen}
            aria-label={label}
            className={cn(
                "block size-20 cursor-zoom-in overflow-hidden rounded-md border",
                failed ? "border-danger" : "border-border"
            )}
        >
            {/* eslint-disable-next-line @next/next/no-img-element -- a local blob or Polaris's own file route, no loader wanted */}
            <img
                src={src}
                alt={name}
                title={imageTitle}
                className={cn("size-full object-cover", imageClassName)}
            />
        </button>
    );
});
