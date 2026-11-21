"use client";

/**
 * Polar's answer drawn as it is written - a row at the end of the conversation
 * that grows, the way an AI's answer grows in a WhatsApp chat - and then the
 * posted answer in its place without anything moving.
 *
 * The row is a message like any other (`draftRow`): Polar's face, name and AI
 * tag, the quote of what it answers, the text through the same renderer. So the
 * draft is as tall as the message that replaces it, and when the answer lands
 * it takes the draft's key (`draftKeyOf`), and React keeps what it drew rather
 * than drawing it again. While it grows, the list follows it for a reader at the
 * bottom and leaves a reader further up where they are, as for any height that
 * changes at the end.
 *
 * Nothing is built on a draft: no reply, reaction or menu until it is a message.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMessageView } from "@/lib/chat/messages";
import { POLAR_NAME } from "@/components/polar/polar-bot";
import type { ChatFrame } from "./use-chat-stream";

const ROW = "polar-draft:";

const NONE: readonly ChatMessageView[] = [];

/** A draft with no frame for this long is gone: the server restarted, or the
 *  turn died without saying so. Text arrives several times a second, and a
 *  step on its tools takes the draft back rather than leaving it. */
export const DRAFT_STALE_MS = 30_000;

/** How many landed answers keep their draft's key. A handful are ever on
 *  screen; the bound only stops a tab left open for weeks from growing. */
const LANDINGS_KEPT = 200;

export function draftRowId(key: string): string {
    return `${ROW}${key}`;
}

/** Whether a row in the list is Polar's answer still being written. */
export function isDraftRow(id: string): boolean {
    return id.startsWith(ROW);
}

/** Answers that replaced a draft, to the key the draft was drawn under. */
const landings = new Map<string, string>();

/** The key a landed answer is drawn under: its draft's, so it is not drawn twice. */
export function draftKeyOf(messageId: string): string | undefined {
    return landings.get(messageId);
}

function noteLanding(messageId: string, key: string): void {
    landings.set(messageId, draftRowId(key));
    if (landings.size > LANDINGS_KEPT) landings.delete(landings.keys().next().value!);
}

export interface PolarDraft {
    readonly key: string;
    readonly text: string;
    readonly messageId?: string;
    /** When this screen first saw it, which is where the row sits in time. */
    readonly startedAt: string;
    /** The last frame, for `DRAFT_STALE_MS`. */
    readonly at: number;
}

/** One line of the asking message, as the posted answer's quote reads it. */
function excerptOf(message: ChatMessageView): string {
    return message.body.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * The draft as a row of the conversation: the posted answer as it will look,
 * with what has been written so far. `asked` is the message it answers, when
 * this screen holds it. Pure.
 */
export function draftRow(
    draft: PolarDraft,
    channelId: string,
    asked: ChatMessageView | undefined
): ChatMessageView {
    return {
        id: draftRowId(draft.key),
        channelId,
        authorId: null,
        authorName: POLAR_NAME,
        fromAgent: "polar",
        kind: "text",
        body: draft.text,
        parentId: asked?.parentId ?? null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        quote: {
            id: draft.key,
            channelId: asked ? channelId : null,
            authorName: asked?.authorName ?? null,
            excerpt: asked ? excerptOf(asked) : "",
            deleted: false,
            forwarded: false
        },
        starred: false,
        references: [],
        forwardable: false,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: draft.startedAt
    } as unknown as ChatMessageView;
}

/**
 * The rows of Polar's answers being written in this conversation (`parentId`
 * null) or in one thread, for appending to `messages`, and `onFrame` for the
 * screen's own stream handler to pass every frame to - one subscription per
 * screen, not one more. A draft whose answer is already among `messages` is
 * left out in the same render the answer appears.
 */
export function usePolarDrafts(
    channelId: string,
    parentId: string | null,
    stored: readonly ChatMessageView[] | null
): { readonly rows: readonly ChatMessageView[]; readonly onFrame: (frame: ChatFrame) => void } {
    const messages = stored ?? NONE;
    const [drafts, setDrafts] = useState<ReadonlyMap<string, PolarDraft>>(() => new Map());

    useEffect(() => setDrafts(new Map()), [channelId, parentId]);

    const onFrame = useCallback(
        (frame: ChatFrame) => {
            if (
                frame.kind !== "draft" ||
                frame.channelId !== channelId ||
                frame.parentId !== parentId
            )
                return;
            if (frame.messageId) noteLanding(frame.messageId, frame.key);
            setDrafts((current) => {
                const next = new Map(current);
                if (!frame.text && !frame.messageId) next.delete(frame.key);
                else
                    next.set(frame.key, {
                        key: frame.key,
                        text: frame.text,
                        ...(frame.messageId ? { messageId: frame.messageId } : {}),
                        startedAt: current.get(frame.key)?.startedAt ?? new Date().toISOString(),
                        at: Date.now()
                    });
                return next;
            });
        },
        [channelId, parentId]
    );

    // Landed, or gone quiet: let go of it.
    const held = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
    useEffect(() => {
        if (drafts.size === 0) return;
        const sweep = () =>
            setDrafts((current) => {
                const cutoff = Date.now() - DRAFT_STALE_MS;
                const kept = [...current].filter(
                    ([, draft]) =>
                        draft.at > cutoff && !(draft.messageId && held.has(draft.messageId))
                );
                return kept.length === current.size ? current : new Map(kept);
            });
        sweep();
        const timer = setInterval(sweep, 5_000);
        return () => clearInterval(timer);
    }, [drafts.size, held]);

    const rows = useMemo(() => {
        if (drafts.size === 0) return NONE;
        const byId = new Map(messages.map((message) => [message.id, message]));
        return [...drafts.values()]
            .filter((draft) => draft.text && !(draft.messageId && byId.has(draft.messageId)))
            .map((draft) => draftRow(draft, channelId, byId.get(draft.key)));
    }, [drafts, messages, channelId]);
    return { rows, onFrame };
}
