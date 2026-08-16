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
import { Skeleton } from "@polaris/ui";
import { useChat } from "./chat-context";
import { MessageList } from "./message-list";
import { runAction } from "@/lib/run-action";
import { useChatStream } from "./use-chat-stream";
import { useCallback, useEffect, useState } from "react";
import type { ChatMessageView } from "@/lib/chat/messages";

export function ThreadPanel({
    root,
    rules,
    viewerId,
    canPost,
    canModerate,
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
    /** A reply to point at, for somebody who arrived from a link to it rather
     *  than by opening the thread. Scrolled to once the thread has drawn. */
    highlightId?: string | null;
    onClose: () => void;
    /** Called after a write, so the channel behind can update the reply count
     *  on the message this thread hangs off. */
    onChanged: () => void;
}) {
    const { may } = useChat();
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(null);
    const [error, setError] = useState("");

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
        <aside className="flex w-full max-w-sm shrink-0 flex-col border-l border-border">
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

            <div className="min-h-0 flex-1 overflow-y-auto py-2">
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
                        onReply={() => {
                            // A thread is already the reply. Quoting inside one
                            // would be a reply to a reply with no room to draw
                            // it, so the action is left to the channel.
                        }}
                        onForward={() => {
                            // Same: forwarding out of a thread is done from the
                            // channel, where the whole conversation is.
                        }}
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
                        onEdit={() => {
                            // Editing happens in the channel's own composer, which
                            // is the one place a message is rewritten.
                        }}
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
                rules={rules}
                disabled={!canPost}
                attachable={may.attach}
                placeholder="Reply in this thread"
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
    );
}
