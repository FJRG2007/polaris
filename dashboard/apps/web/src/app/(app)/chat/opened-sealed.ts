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
import type { ChatPollView } from "@/lib/chat/polls";
import * as sealedFiles from "@/lib/chat/e2ee/sealed-files";
import { isInlineImage } from "@/lib/mime";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { sealedStill, stillTried, takeSealedStill, wantsStill } from "./sealed-stills";
import * as sealedReactions from "./sealed-reactions";

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
    fileUrl: (id: string) => string | undefined = sealedFiles.openedFileUrl,
    stillUrl: (id: string) => string | undefined = sealedStill
): readonly ChatMessageView[] {
    let changed = false;
    const out = messages.map((message) => {
        // A row drawn with an edit still waiting here already carries its words.
        if (!message.sealed || message.changeWaiting) return message;
        const content = opened(message.id, message.sealedEditedAt);
        if (!content) return message;
        changed = true;
        const poll = message.poll && content.poll ? openedPoll(message.poll, content.poll) : message.poll;
        if (!content.files || !message.attachments) return { ...message, body: content.body, poll };
        const refs = new Map(content.files.map((ref) => [ref.id, ref]));
        return {
            ...message,
            body: content.body,
            poll,
            attachments: message.attachments.map((file) => {
                const ref = file.sealed ? refs.get(file.id) : undefined;
                return ref ? openedFile(file, ref, fileUrl(ref.id), stillUrl(ref.id)) : file;
            })
        };
    });
    return changed ? out : messages;
}

/** A sealed poll's answers named from its seal, by position (the server's answer rows hold no words). */
export function openedPoll(poll: ChatPollView, sealed: sealedChat.SealedPoll): ChatPollView {
    return { ...poll, options: poll.options.map((option, at) => (option.text ? option : { ...option, text: sealed.options[at] ?? "" })) };
}

/** `fresh` with each answer's words taken from `drawn` where the server sent none (a sealed poll). */
export function keepTexts(fresh: ChatPollView, drawn: ChatPollView): ChatPollView {
    const words = new Map(drawn.options.map((option) => [option.id, option.text]));
    return { ...fresh, options: fresh.options.map((option) => (option.text ? option : { ...option, text: words.get(option.id) ?? "" })) };
}

/** A sealed attachment drawn as what its seal says it is; `url` once its bytes opened on this page. */
export function openedFile(
    file: ChatAttachmentView,
    ref: sealedChat.SealedFileRef,
    url: string | undefined,
    still?: string
): ChatAttachmentView {
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
        ...(url ? { openedUrl: url } : {}),
        ...(still ? { openedPosterUrl: still } : {})
    };
}

/** The sealed files of these opened messages that this page has not opened yet. */
export function unopenedFiles(
    messages: readonly ChatMessageView[],
    opened: (id: string, editedAt?: string) => sealedChat.SealedContent | null | undefined = sealedChat.openedContent,
    wanted: (ref: sealedChat.SealedFileRef) => boolean = () => true
): sealedChat.SealedFileRef[] {
    const out: sealedChat.SealedFileRef[] = [];
    for (const message of messages) {
        // Some surfaces (pins, search hits) carry no attachment list at all.
        if (!message.sealed || !message.attachments?.some((file) => file.sealed)) continue;
        const files = opened(message.id, message.sealedEditedAt)?.files ?? [];
        const stored = new Set(message.attachments.filter((file) => file.sealed).map((file) => file.id));
        for (const ref of files) if (stored.has(ref.id) && wanted(ref) && !sealedFiles.openedFileUrl(ref.id)) out.push(ref);
    }
    return out;
}

/** `messages` drawn opened; `wanted` picks which of their sealed files are fetched and opened (all by default). */
/** The opened sealed videos of these messages with no still tried on this page yet. */
export function stillsToTake(
    messages: readonly ChatMessageView[],
    opened: (id: string, editedAt?: string) => sealedChat.SealedContent | null | undefined = sealedChat.openedContent
): { ref: sealedChat.SealedFileRef; url: string }[] {
    const out: { ref: sealedChat.SealedFileRef; url: string }[] = [];
    for (const message of messages) {
        if (!message.sealed || !message.attachments?.some((file) => file.sealed)) continue;
        for (const ref of opened(message.id, message.sealedEditedAt)?.files ?? []) {
            const url = sealedFiles.openedFileUrl(ref.id);
            if (url && wantsStill(ref) && !stillTried(ref.id)) out.push({ ref, url });
        }
    }
    return out;
}

export function useOpenedSealed(
    messages: readonly ChatMessageView[],
    wanted?: (ref: sealedChat.SealedFileRef) => boolean
): readonly ChatMessageView[] {
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
        for (const ref of unopenedFiles(messages, sealedChat.openedContent, wanted))
            void sealedFiles.openSealedFile(ref).then((url) => {
                if (url && live) setVersion((current) => current + 1);
            });
        return () => {
            live = false;
        };
    }, [messages, version, wanted]);
    // A still for each opened sealed video (opened here, prefetched, or the sender's own), taken once.
    useEffect(() => {
        if (!sealedChat.sealedChatActive()) return;
        let live = true;
        for (const { ref, url } of stillsToTake(messages))
            void takeSealedStill(ref, url).then((still) => {
                if (still && live) setVersion((current) => current + 1);
            });
        return () => {
            live = false;
        };
    }, [messages, version]);
    // The sealed reaction sets on these messages, read and opened again whenever the rows change
    // (a reaction anywhere publishes a change that brings new rows), at most a page of messages per read.
    useEffect(() => {
        if (!sealedChat.sealedChatActive()) return;
        sealedReactions.noteSealedReactions(messages);
        const wanted = new Map<string, string[]>();
        for (const message of messages)
            if (message.sealedReactions) wanted.set(message.channelId, [...(wanted.get(message.channelId) ?? []), message.id]);
        if (!wanted.size) return;
        let live = true;
        for (const [channelId, ids] of wanted)
            for (let at = 0; at < ids.length; at += 100)
                sealedReactions
                    .loadSealedReactions(channelId, ids.slice(at, at + 100))
                    .then(() => {
                        if (live) setVersion((current) => current + 1);
                    })
                    .catch((caught: unknown) => console.warn("polaris: sealed reactions could not be opened here:", caught));
        return () => {
            live = false;
        };
    }, [messages]);
    // `version` is what says the cache moved.
    return useMemo(() => {
        const shown = withOpened(messages, sealedChat.openedContent);
        const counted = shown.map(sealedReactions.withOpenedReactions);
        // The same list back when no row took sealed reactions, as `withOpened` does.
        return counted.every((message, at) => message === shown[at]) ? shown : counted;
    }, [messages, version]);
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
