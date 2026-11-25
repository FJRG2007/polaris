/**
 * The pictures one message carries, in the order it shows them, for stepping
 * through with the arrows once one of them is open.
 *
 * A picture still under a spoiler cover is left out: stepping onto it in the
 * viewer would uncover it without anybody choosing to. The one already open is
 * always kept, since opening it was the choice.
 */

import type { ChatMessageView } from "@/lib/chat/messages";
import type { ViewedImage } from "@/components/image-viewer";
import { placeholderUrl } from "@/lib/chat/media-shape";

/** An attachment as its address is worked out: a sealed one is drawn from what this page opened. */
export type FileAddress = string | { readonly id: string; readonly sealed?: boolean; readonly openedUrl?: string };

/** Where an attachment's picture is served - the address the viewer opens. */
export function attachmentImageUrl(file: FileAddress): string {
    return attachmentFileUrl(file);
}

/**
 * Where an attachment's bytes are: the route, or for a sealed file the object
 * URL its clear bytes were opened to here (empty until then - the route only
 * holds the sealed blob).
 */
export function attachmentFileUrl(file: FileAddress, variant?: "download"): string {
    if (typeof file !== "string" && file.sealed) return file.openedUrl ?? "";
    const id = typeof file === "string" ? file : file.id;
    return variant === "download" ? `/api/chat/attachments/${id}?download=1` : `/api/chat/attachments/${id}`;
}

export function messageGallery(
    message: Pick<ChatMessageView, "id" | "forwardable" | "attachments">,
    coverAll: boolean,
    openUrl: string
): ViewedImage[] {
    return message.attachments
        .filter((file) => file.inline)
        .filter((file) => !(file.spoiler || coverAll) || attachmentImageUrl(file) === openUrl)
        .map((file) => ({
            url: attachmentImageUrl(file),
            name: file.name,
            messageId: message.id,
            forwardable: message.forwardable,
            placeholder: placeholderUrl(file.thumbhash)
        }));
}
