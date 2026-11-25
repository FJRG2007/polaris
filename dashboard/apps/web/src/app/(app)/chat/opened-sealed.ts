"use client";

/**
 * Sealed rows shown with their content: each message the server marks
 * `sealed` (its body empty) is opened on this device and drawn with the body
 * it opened to, in place - the same row, the same list. With sealed chat off
 * no row is sealed and the list is returned as it came. A row is opened per
 * version (`sealedEditedAt`), so one edited since it was opened is opened again.
 */

import { useEffect, useMemo, useState } from "react";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import type { ChatAttachmentView, ChatMessageView } from "@/lib/chat/messages";
import * as sealedFiles from "@/lib/chat/e2ee/sealed-files";
import { isInlineImage } from "@/lib/mime";
import { plainExcerpt } from "@/components/rich-text/excerpt";

/** As much of an opened body as a list row shows (as `last-messages.ts` cuts a plain one). */
const PREVIEW_CHARS = 160;

/** The sealed rows (as versions) this page has not opened yet, per conversation. */
export function unopened(
    messages: readonly ChatMessageView[],
    opened: (id: string, editedAt?: string) => sealedChat.SealedContent | null | undefined = sealedChat.openedContent
): Map<string, sealedChat.SealedRef[]> {
    const out = new Map<string, sealedChat.SealedRef[]>();
    for (const message of messages) {
        if (!message.sealed || opened(message.id, message.sealedEditedAt) !== undefined) continue;
        const refs = out.get(message.channelId) ?? [];
        refs.push({ id: message.id, editedAt: message.sealedEditedAt });
        out.set(message.channelId, refs);
    }
    return out;
}

/** Draw a sealed row with what its version opened to; one that did not open keeps its empty body. */
export function withOpened(
    messages: readonly ChatMessageView[],
    opened: (id: string, editedAt?: string) => sealedChat.SealedContent | null | undefined,
    fileUrl: (id: string) => string | undefined = sealedFiles.openedFileUrl
): readonly ChatMessageView[] {
    let changed = false;
    const out = messages.map((message) => {
        // A row drawn with an edit still waiting here already carries its words.
        if (!message.sealed || message.changeWaiting) return message;
        const content = opened(message.id, message.sealedEditedAt);
        if (!content) return message;
        changed = true;
        if (!content.files || !message.attachments) return { ...message, body: content.body };
        const refs = new Map(content.files.map((ref) => [ref.id, ref]));
        return {
            ...message,
            body: content.body,
            attachments: message.attachments.map((file) => {
                const ref = file.sealed ? refs.get(file.id) : undefined;
                return ref ? openedFile(file, ref, fileUrl(ref.id)) : file;
            })
        };
    });
    return changed ? out : messages;
}

/** A sealed attachment drawn as what its seal says it is; `url` once its bytes opened on this page. */
export function openedFile(file: ChatAttachmentView, ref: sealedChat.SealedFileRef, url: string | undefined): ChatAttachmentView {
    return {
        ...file,
        name: ref.name,
        contentType: ref.type,
        size: ref.size,
        width: ref.shape?.w ?? null,
        height: ref.shape?.h ?? null,
        thumbhash: ref.shape?.th ?? null,
        durationMs: ref.durationMs ?? null,
        waveform: ref.waveform ?? null,
        spoiler: ref.spoiler === true,
        inline: isInlineImage(ref.type),
        hasPoster: false,
        ...(url ? { openedUrl: url } : {})
    };
}

/** The sealed files of these opened messages that this page has not opened yet. */
export function unopenedFiles(
    messages: readonly ChatMessageView[],
    opened: (id: string, editedAt?: string) => sealedChat.SealedContent | null | undefined = sealedChat.openedContent
): sealedChat.SealedFileRef[] {
    const out: sealedChat.SealedFileRef[] = [];
    for (const message of messages) {
        // Some surfaces (pins, search hits) carry no attachment list at all.
        if (!message.sealed || !message.attachments?.some((file) => file.sealed)) continue;
        const files = opened(message.id, message.sealedEditedAt)?.files ?? [];
        const stored = new Set(message.attachments.filter((file) => file.sealed).map((file) => file.id));
        for (const ref of files) if (stored.has(ref.id) && !sealedFiles.openedFileUrl(ref.id)) out.push(ref);
    }
    return out;
}

export function useOpenedSealed(messages: readonly ChatMessageView[]): readonly ChatMessageView[] {
    // Bumped when an open lands, so the rows are drawn again from the page's cache.
    const [version, setVersion] = useState(0);
    useEffect(() => {
        if (!sealedChat.sealedChatActive()) return;
        const wanted = unopened(messages);
        if (!wanted.size) return;
        let live = true;
        for (const [channelId, ids] of wanted)
            sealedChat
                .openSealed(channelId, ids)
                .then(() => {
                    if (live) setVersion((current) => current + 1);
                })
                .catch((caught: unknown) => console.warn("polaris: sealed messages could not be opened here:", caught));
        return () => {
            live = false;
        };
    }, [messages]);
    // The files of opened messages, fetched and opened once each; a row draws one when it lands.
    useEffect(() => {
        if (!sealedChat.sealedChatActive()) return;
        let live = true;
        for (const ref of unopenedFiles(messages))
            void sealedFiles.openSealedFile(ref).then((url) => {
                if (url && live) setVersion((current) => current + 1);
            });
        return () => {
            live = false;
        };
    }, [messages, version]);
    // `version` is what says the cache moved.
    return useMemo(() => withOpened(messages, sealedChat.openedContent), [messages, version]);
}

/** The same for a list whose entries each hold one message (pins, search hits). */
export function useOpenedWithin<T extends { readonly message: ChatMessageView }>(entries: readonly T[] | null): readonly T[] | null {
    const inner = useMemo(() => (entries ?? []).map((entry) => entry.message), [entries]);
    const opened = useOpenedSealed(inner);
    return useMemo(() => {
        if (!entries || opened === inner) return entries;
        return entries.map((entry, index) => (opened[index] === entry.message ? entry : { ...entry, message: opened[index]! }));
    }, [entries, inner, opened]);
}

/**
 * A conversation's last line with a sealed message opened on this device and
 * cut to one row; empty until it opens, and if it does not.
 */
export function useOpenedLast<T extends { readonly body: string; readonly sealedId?: string; readonly sealedEditedAt?: string }>(
    channelId: string,
    last: T | null
): T | null {
    const id = last?.sealedId;
    const editedAt = last?.sealedEditedAt;
    const [version, setVersion] = useState(0);
    useEffect(() => {
        if (!id || !sealedChat.sealedChatActive() || sealedChat.openedContent(id, editedAt) !== undefined) return;
        let live = true;
        sealedChat
            .openSealed(channelId, [{ id, editedAt }])
            .then(() => {
                if (live) setVersion((current) => current + 1);
            })
            .catch((caught: unknown) => console.warn("polaris: a sealed message could not be opened here:", caught));
        return () => {
            live = false;
        };
    }, [channelId, id, editedAt]);
    return useMemo(() => {
        if (!last || !id) return last;
        const content = sealedChat.openedContent(id, editedAt);
        return content ? { ...last, body: plainExcerpt(content.body, PREVIEW_CHARS) } : last;
    }, [last, id, editedAt, version]);
}
