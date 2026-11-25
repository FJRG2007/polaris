/**
 * The gallery's tiles from what the server listed: a plain picture or video as
 * it came, a sealed file as what its opened message says it is. A sealed file
 * that opened to anything but a picture or a video is left out, as is one that
 * did not open; one still opening is a tile that cannot be opened yet.
 */

import type { SharedMediaItem } from "./actions";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { SealedContent, SealedFileRef } from "@/lib/chat/e2ee/sealed-chat";

export interface SharedTile extends SharedMediaItem {
    /** A sealed file's opened bytes, drawn and viewed from this page. */
    readonly openedUrl?: string;
    /** A sealed video's still, taken on this page. */
    readonly openedPosterUrl?: string;
    /** A sealed file this page is still opening: drawn, not yet viewable. */
    readonly pending?: boolean;
}

/** A sealed file worth opening for the gallery: a picture or a video that is not covered. */
export function galleryRef(ref: SealedFileRef): boolean {
    return /^(image|video)\//.test(ref.type) && ref.spoiler !== true;
}

export interface SealedState {
    /** Whether this page can open sealed messages at all. */
    readonly readable: boolean;
    /** What a message version opened to: undefined while it opens, null if it did not. */
    readonly content: (id: string, editedAt?: string) => SealedContent | null | undefined;
    /** Whether a sealed file's bytes failed to open here. */
    readonly fileFailed: (id: string) => boolean;
}

export function sharedTiles(
    items: readonly SharedMediaItem[],
    sealed: readonly ChatMessageView[],
    state: SealedState
): readonly SharedTile[] {
    if (!items.some((item) => item.sealed)) return items;
    const messages = new Map(sealed.map((message) => [message.id, message]));
    return items.flatMap((item): SharedTile[] => {
        if (!item.sealed) return [item];
        const message = messages.get(item.messageId);
        if (!state.readable || !message || state.fileFailed(item.id)) return [];
        const content = state.content(message.id, message.sealedEditedAt);
        if (content === null) return [];
        if (content === undefined) return [{ ...item, name: "", pending: true }];
        const ref = content.files?.find((file) => file.id === item.id);
        if (!ref || !galleryRef(ref)) return [];
        const file = message.attachments?.find((entry) => entry.id === item.id);
        const url = file?.openedUrl;
        const still = file?.openedPosterUrl;
        return [
            {
                ...item,
                name: ref.name,
                video: ref.type.startsWith("video/"),
                durationMs: ref.durationMs ?? null,
                hasPoster: false,
                thumbhash: ref.shape?.th ?? null,
                ...(url ? { openedUrl: url } : { pending: true }),
                ...(still ? { openedPosterUrl: still } : {})
            }
        ];
    });
}
