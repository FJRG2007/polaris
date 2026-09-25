"use client";

/**
 * A thread, beside the channel rather than inside it.
 *
 * The point of a thread is that a side conversation does not push the main one
 * off the screen, which only works if both are visible at once. A thread that
 * replaced the channel would be a channel with extra steps.
 *
 * One level deep. A reply to a reply joins this same thread, which the service
 * enforces - so there is no second panel, no breadcrumb, and no way to get lost
 * three levels down a conversation nobody can find again.
 */

import { X } from "lucide-react";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { Composer } from "./composer";
import { useChat } from "./chat-context";
import { threadDraftKey } from "./drafts";
import { MessageList } from "./message-list";
import { runAction } from "@/lib/run-action";
import type { PollDraft } from "./poll-dialog";
import { useChatStream } from "./use-chat-stream";
import { ResizeHandle, Skeleton } from "@polaris/ui";
import type { ChatMessageView } from "@/lib/chat/messages";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useChatPane } from "./use-chat-pane";
import { resetPaneLayout } from "./pane-preferences";
import { PersonCardProvider } from "./person-card";

/**
 * What the thread may be narrowed and widened to.
 *
 * The fallback is the width it has always been drawn at. The floor is where a
 * reply stops being a paragraph and starts being a column of single words; the
 * ceiling is where the conversation it hangs off becomes the narrow one.
 */
const THREAD_PANE = { min: 280, max: 560, fallback: 384 };

export function ThreadPanel({
    root,
    rules,
    viewerId,
    canPost,
    canModerate,
    roomMentions = true,
    highlightId = null,
    onClose,
    onChanged
}: {
    root: ChatMessageView;
    /** The channel's rules, handed down rather than resolved again: a thread is
     *  in the conversation it hangs off and is under the same limits. */
    rules: core.ChatRules;
    viewerId: string;
    canPost: boolean;
    canModerate: boolean;
    /** Whether the reply box offers `@everyone` and `@here` - the channel's
     *  answer, handed down like its rules. */
    roomMentions?: boolean;
    /** A reply to point at, for somebody who arrived from a link to it rather
     *  than by opening the thread. Scrolled to once the thread has drawn. */
    highlightId?: string | null;
    onClose: () => void;
    /** Called after a write, so the channel behind can update the reply count
     *  on the message this thread hangs off. */
    onChanged: () => void;
}) {
    const { may } = useChat();
    // Held to what the row can spare: a remembered width from a wider window, or
    // a second panel opened beside this one, is how the conversation gets
    // squeezed to nothing.
    const { drawn, ceiling, measure, resize, reset } = useChatPane("thread", THREAD_PANE);
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(null);
    const [error, setError] = useState("");
    /** Somebody to drop into the reply being written. The thread has its own box,
     *  so a name mentioned in here belongs in this one rather than in the
     *  channel's - see the composer's `insert`. */
    const [inserting, setInserting] = useState<{ token: number; text: string } | null>(null);

    const load = useCallback(async () => {
        const result = await actions.readThreadAction(root.id);
        if (result.error) {
            setError(result.error);
            setMessages([]);
            return;
        }
        setMessages(result.messages ?? []);
    }, [root.id]);

    useEffect(() => {
        setMessages(null);
        void load();
    }, [load]);

    // A thread opened from a link to one of its replies. The panel draws the
    // whole thread, so on a long one the reply somebody followed can be well
    // below the fold - which would look like the link went to the wrong place.
    useEffect(() => {
        if (!highlightId || messages === null) return;
        document.getElementById(`message-${highlightId}`)?.scrollIntoView({ block: "center" });
    }, [highlightId, messages]);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind === "posted" && frame.channels.includes(root.channelId)) void load();
            },
            [root.channelId, load]
        )
    );

    return (
        // A card opened from a name in the thread writes a mention into the
        // thread's own box, not the channel's.
        <PersonCardProvider
            channelId={root.channelId}
            viewerId={viewerId}
            onMention={(text) =>
                setInserting((current) => ({ token: (current?.token ?? 0) + 1, text }))
            }
        >
            {/* The panel is after the line, so dragging towards it widens it -
                which is what `side` tells the handle. Only where there is a
                conversation beside it: on a phone the thread is the screen. */}
            <ResizeHandle
                axis="x"
                side="end"
                size={drawn}
                min={THREAD_PANE.min}
                max={ceiling}
                onChange={resize}
                onReset={reset}
                onResetAll={resetPaneLayout}
                label="Thread width"
                className="hidden md:block"
            />
            <aside
                ref={measure}
                style={{ "--thread-pane": `${drawn}px` } as CSSProperties}
                className="flex w-full shrink-0 flex-col border-l border-border md:w-[var(--thread-pane)]"
            >
                <div className="flex h-header shrink-0 items-center justify-between gap-2 border-b border-border px-3">
                    <span className="text-sm font-semibold">Thread</span>
                    <button
                        type="button"
                        aria-label="Close the thread"
                        onClick={onClose}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <X className="size-4" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
                    {messages === null ? (
                        <div className="flex flex-col gap-3 p-4" aria-hidden="true">
                            {[0, 1].map((row) => (
                                <Skeleton key={row} className="h-8 w-2/3" />
                            ))}
                        </div>
                    ) : (
                        <MessageList
                            messages={messages}
                            viewerId={viewerId}
                            canPost={canPost}
                            canModerate={canModerate}
                            highlightId={highlightId}
                            // No onReply, onForward or onEdit: a thread is already the
                            // reply, forwarding out of one is done from the channel,
                            // and a message is rewritten in the channel's own
                            // composer. Left off rather than passed as nothing, which
                            // is what drew three controls in here that did nothing at
                            // all when they were pressed.
                            onStar={async (message) => {
                                await runAction(() => actions.starAction(message.id), setError);
                                await load();
                            }}
                            onReact={async (messageId, emoji) => {
                                await runAction(
                                    () => actions.reactAction({ messageId, emoji }),
                                    setError
                                );
                                await load();
                            }}
                            onMention={(text) =>
                                setInserting((current) => ({
                                    token: (current?.token ?? 0) + 1,
                                    text
                                }))
                            }
                            onDelete={async (message) => {
                                await runAction(
                                    () => actions.deleteMessageAction(message.id),
                                    setError
                                );
                                await load();
                                onChanged();
                            }}
                        />
                    )}
                </div>

                {error && (
                    <p role="alert" className="px-3 pb-1 text-xs text-danger">
                        {error}
                    </p>
                )}

                <Composer
                    channelId={root.channelId}
                    onTyping={(kind) => void actions.typingAction(root.channelId, kind)}
                    // Its own, under the message it answers: a half-written reply
                    // to a thread belongs to that thread and not to the channel it
                    // hangs off.
                    draftKey={threadDraftKey(root.id)}
                    roomMentions={roomMentions}
                    rules={rules}
                    insert={inserting}
                    disabled={!canPost}
                    attachable={may.attach}
                    placeholder="Reply in this thread"
                    // A poll belongs in a thread as readily as anywhere else: a side
                    // conversation is exactly where somebody asks the room to pick
                    // between the two things being argued about.
                    onPoll={async (draft: PollDraft) => {
                        const result = await actions.createPollAction({
                            channelId: root.channelId,
                            ...draft,
                            parentId: root.id
                        });
                        if (result.error) return { error: result.error };
                        await load();
                        onChanged();
                        return {};
                    }}
                    onMedia={async (address) => {
                        await runAction(
                            () => actions.sendMediaAction(root.channelId, address, root.id),
                            setError
                        );
                        await load();
                        onChanged();
                    }}
                    onSend={async (body, files) => {
                        if (files.length > 0) {
                            // A reply with files takes the same route a message does,
                            // with the thread named on it.
                            const form = new FormData();
                            form.set("body", body);
                            form.set("parentId", root.id);
                            for (const file of files) form.append("files", file);
                            const response = await fetch(
                                `/api/chat/channels/${root.channelId}/messages`,
                                { method: "POST", body: form }
                            );
                            if (!response.ok) {
                                setError("That could not be sent");
                                return;
                            }
                        } else {
                            await runAction(
                                () =>
                                    actions.sendAction({
                                        channelId: root.channelId,
                                        body,
                                        parentId: root.id
                                    }),
                                setError
                            );
                        }
                        await load();
                        onChanged();
                    }}
                />
            </aside>
        </PersonCardProvider>
    );
}
