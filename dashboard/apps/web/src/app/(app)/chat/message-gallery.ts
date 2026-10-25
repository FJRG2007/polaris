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

/** Where an attachment's picture is served - the address the viewer opens. */
export function attachmentImageUrl(id: string): string {
    return `/api/chat/attachments/${id}`;
}

export function messageGallery(
    message: Pick<ChatMessageView, "id" | "forwardable" | "attachments">,
    coverAll: boolean,
    openUrl: string
): ViewedImage[] {
    return message.attachments
        .filter((file) => file.inline)
        .filter((file) => !(file.spoiler || coverAll) || attachmentImageUrl(file.id) === openUrl)
        .map((file) => ({
            url: attachmentImageUrl(file.id),
            name: file.name,
            messageId: message.id,
            forwardable: message.forwardable
        }));
}
