"use client";

/**
 * Sealed rows shown with their content: each message the server marks
 * `sealed` (its body empty) is opened on this device and drawn with the body
 * it opened to, in place - the same row, the same list. With sealed chat off
 * no row is sealed and the list is returned as it came.
 */

import { useEffect, useMemo, useState } from "react";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import type { ChatMessageView } from "@/lib/chat/messages";
import { plainExcerpt } from "@/components/rich-text/excerpt";

/** As much of an opened body as a list row shows (as `last-messages.ts` cuts a plain one). */
const PREVIEW_CHARS = 160;

/** The ids of sealed rows this page has not opened yet, per conversation. */
function unopened(messages: readonly ChatMessageView[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const message of messages) {
        if (!message.sealed || sealedChat.openedContent(message.id) !== undefined) continue;
        const ids = out.get(message.channelId) ?? [];
        ids.push(message.id);
        out.set(message.channelId, ids);
    }
    return out;
}

/** Draw a sealed row with what it opened to; one that did not open keeps its empty body. */
export function withOpened(messages: readonly ChatMessageView[], opened: (id: string) => sealedChat.SealedContent | null | undefined): readonly ChatMessageView[] {
    let changed = false;
    const out = messages.map((message) => {
        if (!message.sealed) return message;
        const content = opened(message.id);
        if (!content) return message;
        changed = true;
        return { ...message, body: content.body };
    });
    return changed ? out : messages;
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
export function useOpenedLast<T extends { readonly body: string; readonly sealedId?: string }>(channelId: string, last: T | null): T | null {
    const id = last?.sealedId;
    const [version, setVersion] = useState(0);
    useEffect(() => {
        if (!id || !sealedChat.sealedChatActive() || sealedChat.openedContent(id) !== undefined) return;
        let live = true;
        sealedChat
            .openSealed(channelId, [id])
            .then(() => {
                if (live) setVersion((current) => current + 1);
            })
            .catch((caught: unknown) => console.warn("polaris: a sealed message could not be opened here:", caught));
        return () => {
            live = false;
        };
    }, [channelId, id]);
    return useMemo(() => {
        if (!last || !id) return last;
        const content = sealedChat.openedContent(id);
        return content ? { ...last, body: plainExcerpt(content.body, PREVIEW_CHARS) } : last;
    }, [last, id, version]);
}
