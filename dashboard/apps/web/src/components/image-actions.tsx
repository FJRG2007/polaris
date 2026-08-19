"use client";

/**
 * What can be done with a picture, wherever it is being looked at.
 *
 * One set rather than one per surface. A picture opened in the viewer and the
 * same picture still sitting in the conversation are the same picture, and
 * somebody who has learnt that a right-click copies it should not have to open
 * it first to get that back. The viewer draws these as its own menu and as its
 * three dots; the message menu draws them under whatever was right-clicked.
 *
 * Copying the image copies the bytes, which is what somebody pasting into
 * another conversation means. Copying the link copies an address only somebody
 * in the conversation can open, which is what somebody quoting it in a ticket
 * means. Both are here because both are asked for, and neither substitutes for
 * the other.
 */

import { copyText, downloadFile } from "@/app/(app)/chat/links";
import { Copy, Download, ExternalLink, Flag, Forward, Link2 } from "lucide-react";
import type { DropdownMenuItem, DropdownMenuSeparator } from "@polaris/ui";

export interface ActionableImage {
    readonly url: string;
    readonly name: string;
    /** The message it is on, for forwarding and reporting. Absent for a picture
     *  that is not in a conversation - a profile photo, which there is nowhere
     *  to forward and nothing to report. */
    readonly messageId?: string;
    /** Whether whoever sent it lets it be passed on. The menu offers the action
     *  or does not; it never offers one that would be refused. */
    readonly forwardable?: boolean;
}

/**
 * The picture's own address, made absolute.
 *
 * A copied link is for somebody else, so an attachment's path is put on the
 * domain Polaris hands out rather than on this tab's hostname - which may be the
 * LAN name the installer wrote. A picture written into a message already carries
 * its own full address and is handed back untouched.
 */
export function imageLink(url: string, baseUrl: string): string {
    return /^https?:\/\//i.test(url) ? url : `${baseUrl}${url}`;
}

/**
 * Whether Polaris can save this one.
 *
 * A browser refuses to download across origins - it navigates to the picture
 * instead, silently, which reads as the menu item doing the wrong thing. So a
 * picture that lives somewhere else is offered opening and not saving, and the
 * two menus draw one item fewer rather than one that misbehaves.
 */
export function savable(url: string): boolean {
    return url.startsWith("/") && !url.startsWith("//");
}

/**
 * The bytes on the clipboard, and the words to say about it.
 *
 * Fetched and handed over as a blob, because "copy image" means the picture and
 * not its address - pasting a URL into a chat is a link, and somebody copying an
 * image expects to paste an image. PNG because that is the one format every
 * clipboard implementation takes.
 */
export async function copyImage(url: string): Promise<string> {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const painted = await toPng(blob);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": painted })]);
        return "Copied";
    } catch {
        // A browser without the clipboard image API, or a refused permission.
        // The link is the honest fallback and is one press away.
        return "This browser would not take the image - copy the link instead";
    }
}

/**
 * The items themselves.
 *
 * Given the menu's own item and separator rather than choosing one, so the same
 * list can be a dropdown in one place and a right-click menu in another without
 * either of them growing a copy of it.
 */
export function imageItems({
    image,
    baseUrl,
    announce,
    onForward,
    onReport,
    Item,
    Separator
}: {
    image: ActionableImage;
    baseUrl: string;
    /** Say what happened. Copying is the one action with nothing on screen to
     *  show for it, and silence reads as a menu item that did nothing. */
    announce: (words: string) => void;
    /** Send it on. The conversation picker is the caller's - it already has one
     *  for forwarding a message, and a picture is a message. */
    onForward?: (messageId: string) => void;
    onReport?: (messageId: string) => void;
    Item: typeof DropdownMenuItem;
    Separator: typeof DropdownMenuSeparator;
}): React.ReactNode {
    const messageId = image.messageId;
    return (
        <>
            <Item onSelect={() => void copyImage(image.url).then(announce)}>
                <Copy className="size-3.5" />
                Copy image
            </Item>
            <Item
                onSelect={() => {
                    void copyText(imageLink(image.url, baseUrl));
                    announce("Link copied");
                }}
            >
                <Link2 className="size-3.5" />
                Copy media link
            </Item>
            {savable(image.url) && (
                <Item onSelect={() => downloadFile(image.url, image.name)}>
                    <Download className="size-3.5" />
                    Download
                </Item>
            )}
            <Item onSelect={() => window.open(image.url, "_blank", "noopener,noreferrer")}>
                <ExternalLink className="size-3.5" />
                Open in the browser
            </Item>
            {onForward && image.forwardable && messageId && (
                <Item onSelect={() => onForward(messageId)}>
                    <Forward className="size-3.5" />
                    Forward
                </Item>
            )}
            {onReport && messageId && (
                <>
                    <Separator />
                    <Item variant="danger" onSelect={() => onReport(messageId)}>
                        <Flag className="size-3.5" />
                        Report
                    </Item>
                </>
            )}
        </>
    );
}

/**
 * The picture as a PNG.
 *
 * Clipboards take PNG and argue about everything else - a WebP or an AVIF handed
 * over as itself is a paste that silently does nothing in half the applications
 * somebody would paste into. Anything already a PNG is passed straight through.
 */
async function toPng(blob: Blob): Promise<Blob> {
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser cannot convert the image");
        context.drawImage(bitmap, 0, 0);
        const painted = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/png")
        );
        if (!painted) throw new Error("This browser cannot convert the image");
        return painted;
    } finally {
        bitmap.close();
    }
}
