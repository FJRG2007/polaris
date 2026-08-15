"use client";

/**
 * One conversation, open.
 *
 * Three things happen here that are worth stating, because each is what
 * separates a chat that feels alive from one that feels like a form.
 *
 * **It sends optimistically.** The message is on screen before the server has
 * answered, with the sender's own name and face, and it is replaced by the real
 * one when the page reloads. A composer that clears and then waits is the single
 * most noticeable lag in a chat client.
 *
 * **It only scrolls you down if you were already at the bottom.** Somebody
 * reading back through yesterday must not be yanked to the newest line because
 * somebody else typed. If they are at the bottom, they are following along, and
 * the new message brings them with it.
 *
 * **It marks read from what is on screen, not from opening.** Opening a channel
 * and immediately leaving does not clear a hundred unread messages, because you
 * did not read them.
 */

import * as actions from "./actions";
import * as calls from "./meeting-actions";
import { CallRoom } from "./call-room";
import { Composer } from "./composer";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { ThreadPanel } from "./thread-panel";
import { MessageList } from "./message-list";
import { runAction } from "@/lib/run-action";
import { MessageCircle } from "lucide-react";
import { ChannelHeader } from "./channel-header";
import { useChatStream } from "./use-chat-stream";
import type { ChatMessageView } from "@/lib/chat/messages";
import { ConfirmDeleteDialog, EmptyState, Skeleton } from "@polaris/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How close to the bottom still counts as "following along". A few pixels of
 *  slack, because a trackpad rarely lands exactly on zero. */
const AT_BOTTOM_SLACK = 60;

/** How long a typing indicator stays up after the last frame about it. Just
 *  longer than the interval the composer sends them at. */
const TYPING_TTL_MS = 4000;

export function ChannelView({ channelId }: { channelId: string }) {
    const router = useRouter();
    const { viewerId, channels, refresh } = useChat();
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(null);
    const [pending, setPending] = useState<readonly ChatMessageView[]>([]);
    const [olderThan, setOlderThan] = useState<string | null>(null);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [error, setError] = useState("");
    const [thread, setThread] = useState<ChatMessageView | null>(null);
    const [editing, setEditing] = useState<ChatMessageView | null>(null);
    const [deleting, setDeleting] = useState<ChatMessageView | null>(null);
    const [typists, setTypists] = useState<readonly { userId: string; name: string; at: number }[]>([]);
    const [live, setLive] = useState<{ meetingId: string; count: number } | null>(null);
    // The call this tab is actually sitting in, which is not the same question as
    // whether one is running: somebody can watch a channel with a call in it
    // without joining, and must not have their camera opened for them.
    const [inCall, setInCall] = useState<string | null>(null);

    const scroller = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const marked = useRef("");

    const channel = useMemo(
        () => channels.find((entry) => entry.id === channelId) ?? null,
        [channels, channelId]
    );
    const canPost = channel ? !channel.archived : true;

    // Everything about this screen is about one id; a different one is a
    // different conversation and none of the previous state belongs to it.
    useEffect(() => {
        setMessages(null);
        setPending([]);
        setThread(null);
        setEditing(null);
        setError("");
        setInCall(null);
        marked.current = "";
        following.current = true;
    }, [channelId]);

    // Whether there is a call to join, asked on arrival and again whenever
    // something happens in the channel - starting one posts nothing, so the
    // question has to be asked rather than inferred from the messages.
    const checkCall = useCallback(() => {
        void calls
            .liveCallAction(channelId)
            .then(setLive)
            .catch(() => setLive(null));
    }, [channelId]);

    useEffect(checkCall, [checkCall]);

    const load = useCallback(async () => {
        const result = await actions.readChannelAction(channelId);
        if (result.error) {
            setError(result.error);
            setMessages([]);
            return;
        }
        setMessages(result.page?.messages ?? []);
        setOlderThan(result.page?.olderThan ?? null);
        // Anything optimistic that the server has now confirmed is dropped, so
        // a message is never on screen twice.
        setPending((current) =>
            current.filter(
                (entry) => !(result.page?.messages ?? []).some((real) => real.body === entry.body)
            )
        );
    }, [channelId]);

    useEffect(() => {
        void load();
    }, [load]);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind === "posted" && frame.channels.includes(channelId)) {
                    void load();
                    checkCall();
                }
                if (frame.kind === "typing" && frame.channelId === channelId) {
                    setTypists((current) => [
                        ...current.filter((entry) => entry.userId !== frame.userId),
                        { userId: frame.userId, name: frame.name, at: Date.now() }
                    ]);
                }
            },
            [channelId, load, checkCall]
        )
    );

    // Typists expire on their own rather than on a frame saying they stopped:
    // there is no such frame, because a browser that closes mid-sentence would
    // never send it and the dots would stay up forever.
    useEffect(() => {
        if (typists.length === 0) return;
        const timer = setInterval(() => {
            const cutoff = Date.now() - TYPING_TTL_MS;
            setTypists((current) => current.filter((entry) => entry.at > cutoff));
        }, 1000);
        return () => clearInterval(timer);
    }, [typists.length]);

    const shown = useMemo(() => [...(messages ?? []), ...pending], [messages, pending]);

    // Follow the bottom when the reader was already there. Layout effect timing
    // is not needed: the list is not measured, only scrolled.
    useEffect(() => {
        const element = scroller.current;
        if (!element || !following.current) return;
        element.scrollTop = element.scrollHeight;
    }, [shown]);

    // Catching up on what is actually on screen.
    useEffect(() => {
        if (!following.current) return;
        const newest = messages?.[messages.length - 1];
        if (!newest || marked.current === newest.id) return;
        marked.current = newest.id;
        void actions.markReadAction({ channelId, messageId: newest.id }).then(refresh);
    }, [messages, channelId, refresh]);

    const send = async (body: string) => {
        const draft: ChatMessageView = {
            id: `pending:${body}`,
            channelId,
            authorId: viewerId,
            authorName: null,
            kind: "text",
            body,
            parentId: null,
            replyCount: 0,
            lastReplyAt: null,
            edited: false,
            deleted: false,
            reactions: [],
            createdAt: new Date().toISOString()
        };
        setPending((current) => [...current, draft]);
        following.current = true;

        const result = await runAction(() => actions.sendAction({ channelId, body }), setError);
        if (result?.error) {
            setPending((current) => current.filter((entry) => entry.id !== draft.id));
            return;
        }
        await load();
        refresh();
    };

    const react = async (messageId: string, emoji: string) => {
        await runAction(() => actions.reactAction({ messageId, emoji }), setError);
        await load();
    };

    if (!channel && messages === null) {
        return (
            <div className="flex flex-1 flex-col">
                <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
                    <Skeleton className="h-4 w-40" />
                </div>
                <div className="flex flex-1 flex-col justify-end gap-3 p-4" aria-hidden="true">
                    {[0, 1, 2, 3].map((row) => (
                        <div key={row} className="flex gap-2">
                            <Skeleton className="size-7 rounded-full" />
                            <div className="flex flex-1 flex-col gap-1">
                                <Skeleton className="h-3 w-32" />
                                <Skeleton className="h-3 w-2/3" />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (!channel) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState
                    icon={<MessageCircle />}
                    title="This conversation is not yours to open."
                    description={error || "It may have been deleted, or you may have been removed from it."}
                />
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
                <ChannelHeader
                    channel={channel}
                    onChanged={refresh}
                    call={live}
                    onStartCall={async () => {
                        const result = await calls.startCallAction(channelId);
                        if (result.error) {
                            setError(result.error);
                            return;
                        }
                        if (result.meetingId) setInCall(result.meetingId);
                        checkCall();
                    }}
                />

                {inCall && (
                    <div className="flex max-h-[60%] min-h-0 shrink-0 flex-col border-b border-border">
                        <CallRoom
                            meetingId={inCall}
                            canShare
                            onLeave={() => {
                                setInCall(null);
                                checkCall();
                            }}
                        />
                    </div>
                )}

                <div
                    ref={scroller}
                    onScroll={(event) => {
                        const element = event.currentTarget;
                        following.current =
                            element.scrollHeight - element.scrollTop - element.clientHeight <
                            AT_BOTTOM_SLACK;
                    }}
                    className="min-h-0 flex-1 overflow-y-auto py-2"
                >
                    {olderThan && (
                        <div className="flex justify-center py-2">
                            <button
                                type="button"
                                disabled={loadingOlder}
                                onClick={async () => {
                                    setLoadingOlder(true);
                                    const result = await actions.readChannelAction(
                                        channelId,
                                        olderThan
                                    );
                                    setLoadingOlder(false);
                                    if (!result.page) return;
                                    setMessages((current) => [
                                        ...result.page!.messages,
                                        ...(current ?? [])
                                    ]);
                                    setOlderThan(result.page.olderThan);
                                }}
                                className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
                            >
                                {loadingOlder ? "Loading" : "Load earlier messages"}
                            </button>
                        </div>
                    )}

                    {messages === null ? (
                        <div className="flex flex-col gap-3 p-4" aria-hidden="true">
                            {[0, 1, 2].map((row) => (
                                <Skeleton key={row} className="h-8 w-2/3" />
                            ))}
                        </div>
                    ) : shown.length === 0 ? (
                        <div className="flex h-full items-center justify-center p-6">
                            <EmptyState
                                title="Nothing here yet."
                                description="Say something. Everybody in this conversation will see it."
                            />
                        </div>
                    ) : (
                        <MessageList
                            messages={shown}
                            viewerId={viewerId}
                            canPost={canPost}
                            canModerate={false}
                            onOpenThread={setThread}
                            onReact={react}
                            onEdit={setEditing}
                            onDelete={setDeleting}
                        />
                    )}
                </div>

                <TypingLine typists={typists} viewerId={viewerId} />

                {error && (
                    <p role="alert" className="px-4 pb-1 text-xs text-destructive">
                        {error}
                    </p>
                )}

                <Composer
                    channelId={channelId}
                    disabled={!canPost}
                    placeholder={
                        canPost
                            ? `Message ${channel.kind === "text" ? `#${channel.name}` : channel.name}`
                            : "This conversation is archived."
                    }
                    editing={editing}
                    onCancelEdit={() => setEditing(null)}
                    onSend={send}
                    onSaveEdit={async (messageId, body) => {
                        await runAction(() => actions.editAction({ messageId, body }), setError);
                        setEditing(null);
                        await load();
                    }}
                />
            </div>

            {thread && (
                <ThreadPanel
                    root={thread}
                    viewerId={viewerId}
                    canPost={canPost}
                    onClose={() => setThread(null)}
                    onChanged={() => void load()}
                />
            )}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.body.slice(0, 40) ?? ""}
                kind="message"
                requireTyping={false}
                description="It leaves a line saying it was deleted, so any replies under it still make sense."
                confirmLabel="Delete message"
                onConfirm={async () => {
                    if (deleting) {
                        await runAction(() => actions.deleteMessageAction(deleting.id), setError);
                    }
                    setDeleting(null);
                    await load();
                    router.refresh();
                }}
            />
        </div>
    );
}

/** Who is composing right now. Names rather than "somebody", because in a
 *  channel of twelve that is the only version of this line that helps. */
function TypingLine({
    typists,
    viewerId
}: {
    typists: readonly { userId: string; name: string }[];
    viewerId: string;
}) {
    const others = typists.filter((entry) => entry.userId !== viewerId);
    if (others.length === 0) return <div className="h-4" aria-hidden="true" />;

    const names =
        others.length === 1
            ? `${others[0]!.name} is typing`
            : others.length === 2
              ? `${others[0]!.name} and ${others[1]!.name} are typing`
              : "Several people are typing";

    return (
        <p aria-live="polite" className="h-4 px-4 text-[11px] text-muted-foreground">
            {names}
        </p>
    );
}
