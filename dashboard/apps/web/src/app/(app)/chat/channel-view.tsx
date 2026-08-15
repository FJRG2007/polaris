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
import * as core from "@polaris/core";
import { Composer } from "./composer";
import { CallRoom } from "./call-room";
import { useChat } from "./chat-context";
import * as calls from "./meeting-actions";
import { useRouter } from "next/navigation";
import { ThreadPanel } from "./thread-panel";
import { SearchPanel } from "./search-panel";
import { MessageList } from "./message-list";
import { runAction } from "@/lib/run-action";
import { ForwardDialog } from "./forward-dialog";
import { ChannelHeader } from "./channel-header";
import { useChatStream } from "./use-chat-stream";
import type { ChatMessageView } from "@/lib/chat/messages";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { MessageCircle, Mic, Video, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmDeleteDialog, EmptyState, Skeleton } from "@polaris/ui";

/** How close to the bottom still counts as "following along". A few pixels of
 *  slack, because a trackpad rarely lands exactly on zero. */
const AT_BOTTOM_SLACK = 60;

/** How long a typing indicator stays up after the last frame about it. Just
 *  longer than the interval the composer sends them at. */
const TYPING_TTL_MS = 4000;

/** How many pages back a jump to a search hit will walk. Fifty messages a page,
 *  so this reaches a long way without letting one click pull a year of a busy
 *  channel into the browser. */
const JUMP_PAGES = 20;

/** How long the message a search led to stays lit. */
const HIGHLIGHT_MS = 2500;

export function ChannelView({
    channelId,
    messageId = null
}: {
    channelId: string;
    /** Arrived at from a link to one message. The conversation opens as it
     *  always does and then walks back to it. */
    messageId?: string | null;
}) {
    const router = useRouter();
    const { viewerId, channels, refresh, rulesFor } = useChat();
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(null);
    const [pending, setPending] = useState<readonly ChatMessageView[]>([]);
    const [olderThan, setOlderThan] = useState<string | null>(null);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [error, setError] = useState("");
    const [thread, setThread] = useState<ChatMessageView | null>(null);
    const [searching, setSearching] = useState(false);
    const [highlight, setHighlight] = useState<string | null>(null);
    const [editing, setEditing] = useState<ChatMessageView | null>(null);
    const [deleting, setDeleting] = useState<ChatMessageView | null>(null);
    const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
    const [forwarding, setForwarding] = useState<ChatMessageView | null>(null);
    const [typists, setTypists] = useState<readonly { userId: string; name: string; at: number }[]>(
        []
    );
    const [live, setLive] = useState<{ meetingId: string; count: number } | null>(null);
    // The call this tab is actually sitting in, which is not the same question as
    // whether one is running: somebody can watch a channel with a call in it
    // without joining, and must not have their camera opened for them.
    const [inCall, setInCall] = useState<string | null>(null);
    // Whether this browser opened its camera on the way in. An audio call is not
    // a different kind of call - it is the same room joined with the camera shut
    // - so it is remembered here rather than anywhere the server can see.
    const [callVideo, setCallVideo] = useState(true);

    const scroller = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const marked = useRef("");
    // Which message each optimistic draft turned into. Reconciling on the id the
    // server gave back rather than on the text is what keeps two people saying
    // "ok" from cancelling each other's draft off the screen.
    const drafts = useRef(0);
    const sent = useRef(new Map<string, string>());
    // The same cursor as `olderThan`, kept as a ref because a jump loads several
    // pages inside one tick and state would still hold the one from before the
    // first of them.
    const olderThanRef = useRef<string | null>(null);
    // The message a link asked for, once it has been walked back to. Kept so a
    // reload of the list - one arrives with every message anybody sends - does
    // not drag the reader back to it over and over.
    const landed = useRef<string | null>(null);

    const channel = useMemo(
        () => channels.find((entry) => entry.id === channelId) ?? null,
        [channels, channelId]
    );
    const canPost = channel ? !channel.archived : true;
    const canModerate = channel?.mayAdminister ?? false;
    // What the instance allows in a conversation of this shape. Until the list
    // has arrived there is no channel to ask about, and the defaults are the
    // permissive ones, so nothing is briefly refused that would be allowed.
    const rules = channel ? rulesFor(channel) : core.DEFAULT_CHAT_RULES;

    // Everything about this screen is about one id; a different one is a
    // different conversation and none of the previous state belongs to it.
    useEffect(() => {
        setMessages(null);
        setPending([]);
        setThread(null);
        setEditing(null);
        setReplyingTo(null);
        setForwarding(null);
        setError("");
        setInCall(null);
        marked.current = "";
        following.current = true;
        olderThanRef.current = null;
        landed.current = null;
        sent.current.clear();
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
        const page = result.page?.messages ?? [];
        setMessages(page);
        olderThanRef.current = result.page?.olderThan ?? null;
        setOlderThan(olderThanRef.current);
        // Anything optimistic that the server has now confirmed is dropped, so
        // a message is never on screen twice.
        setPending((current) =>
            current.filter((entry) => {
                const real = sent.current.get(entry.id);
                return !real || !page.some((message) => message.id === real);
            })
        );
    }, [channelId]);

    useEffect(() => {
        void load();
    }, [load]);

    /** Pull in the page above the oldest message on screen. Returns whether
     *  there is still more above it. */
    const loadOlder = useCallback(async (): Promise<boolean> => {
        let more = false;
        setLoadingOlder(true);
        const cursor = olderThanRef.current;
        if (!cursor) {
            setLoadingOlder(false);
            return false;
        }
        const result = await actions.readChannelAction(channelId, cursor);
        setLoadingOlder(false);
        if (!result.page) return false;
        setMessages((current) => [...result.page!.messages, ...(current ?? [])]);
        olderThanRef.current = result.page.olderThan;
        setOlderThan(result.page.olderThan);
        more = result.page.olderThan !== null;
        return more;
    }, [channelId]);

    /**
     * Scroll to a message, fetching backwards until it is there.
     *
     * A search hit is usually older than the screenful the channel opened on, so
     * "scroll to it" means "load until it exists". Bounded, because a hit from
     * two years ago would otherwise walk the whole conversation into the browser
     * one page at a time.
     */
    const jumpTo = useCallback(
        async (messageId: string) => {
            for (let attempt = 0; attempt < JUMP_PAGES; attempt += 1) {
                const element = document.getElementById(`message-${messageId}`);
                if (element) {
                    following.current = false;
                    element.scrollIntoView({ block: "center" });
                    setHighlight(messageId);
                    setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
                    return;
                }
                if (!(await loadOlder())) break;
            }
            setError("That message is further back than this can reach.");
        },
        [loadOlder]
    );

    // A link straight to a message. Waits for the first page rather than racing
    // it: the message may well be on it, and walking backwards from an empty
    // list would ask for pages that are already on the way.
    useEffect(() => {
        if (!messageId || messages === null || landed.current === messageId) return;
        landed.current = messageId;
        void jumpTo(messageId);
    }, [messageId, messages, jumpTo]);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind === "posted" && frame.channels.includes(channelId)) {
                    void load();
                    checkCall();
                }
                // The count beside the call button, kept honest. Nothing is
                // posted when somebody joins or leaves a call, so before this
                // frame existed the number was whatever it happened to be when
                // this screen last had another reason to ask - which is how one
                // tab said one, another said two, and neither was right.
                if (frame.kind === "call" && frame.channelId === channelId) {
                    setLive(
                        frame.state === "ended" || frame.count === 0
                            ? null
                            : { meetingId: frame.meetingId, count: frame.count }
                    );
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

    const star = async (message: ChatMessageView) => {
        await runAction(() => actions.starAction(message.id), setError);
        await load();
    };

    /**
     * Send.
     *
     * With no files it stays optimistic: the line is on screen before the server
     * answers, which is the whole feel of a chat. With files it cannot be - the
     * bytes have to be written before the message exists - so it posts to the
     * route and waits, and the composer having shown the staged files all along
     * is what stops that wait from looking like nothing happened.
     */
    const send = async (body: string, files: readonly File[] = []) => {
        if (files.length > 0) {
            following.current = true;
            const form = new FormData();
            form.set("body", body);
            if (replyingTo) form.set("replyToId", replyingTo.id);
            for (const file of files) form.append("files", file);
            setReplyingTo(null);
            const response = await fetch(`/api/chat/channels/${channelId}/messages`, {
                method: "POST",
                body: form
            });
            if (!response.ok) {
                const answer: unknown = await response.json().catch(() => null);
                const message =
                    typeof answer === "object" && answer !== null && "error" in answer
                        ? String((answer as { error: unknown }).error)
                        : "That could not be sent";
                setError(message);
                return;
            }
            await load();
            refresh();
            return;
        }
        return sendText(body);
    };

    const sendText = async (body: string) => {
        const draft: ChatMessageView = {
            id: `pending:${++drafts.current}`,
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
            attachments: [],
            quote: null,
            starred: false,
            // The server has not looked at any link in it yet. Left as settled
            // rather than pending on purpose: this draft is replaced by the real
            // message a moment later, and that one asks.
            link: null,
            preview: null,
            previewPending: false,
            // Nothing has happened to it yet, not even leaving. The first tick
            // arrives with the message the reload brings back.
            receipt: null,
            createdAt: new Date().toISOString()
        };
        setPending((current) => [...current, draft]);
        following.current = true;

        const answering = replyingTo?.id ?? null;
        // Cleared before the round trip: the reply bar is about what is being
        // written, and the message has left.
        setReplyingTo(null);

        const result = await runAction(
            () => actions.sendAction({ channelId, body, replyToId: answering }),
            setError
        );
        if (result?.error || !result?.id) {
            setPending((current) => current.filter((entry) => entry.id !== draft.id));
            return;
        }
        sent.current.set(draft.id, result.id);
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
                    description={
                        error || "It may have been deleted, or you may have been removed from it."
                    }
                />
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <ChannelHeader
                    channel={channel}
                    onChanged={refresh}
                    call={live}
                    onStartCall={async (withVideo) => {
                        const result = await calls.startCallAction(channelId);
                        if (result.error) {
                            setError(result.error);
                            return;
                        }
                        setCallVideo(withVideo);
                        if (result.meetingId) setInCall(result.meetingId);
                        checkCall();
                    }}
                    onSearch={() => setSearching((current) => !current)}
                />

                {/* A voice channel is a room AND a record. It used to be only
                    the room - no messages, no composer - which meant the one
                    place a group is most likely to want to drop a link was the
                    one place it could not. The strip is what a room needs that
                    a text channel does not: a way in that is a decision, since
                    a channel that opened your microphone because you clicked
                    its name is a channel people are afraid to click. */}
                {channel.kind === "voice" && !inCall && (
                    <VoiceStrip
                        name={channel.name}
                        count={live?.count ?? 0}
                        onJoin={(video) => {
                            setCallVideo(video);
                            void calls.startCallAction(channelId).then((result) => {
                                if (result.error) {
                                    setError(result.error);
                                    return;
                                }
                                if (result.meetingId) setInCall(result.meetingId);
                                checkCall();
                            });
                        }}
                    />
                )}

                {inCall && (
                    <div className="flex max-h-[60%] min-h-0 shrink-0 flex-col border-b border-border">
                        <CallRoom
                            meetingId={inCall}
                            withVideo={callVideo}
                            viewerId={viewerId}
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
                                onClick={() => void loadOlder()}
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
                            canModerate={canModerate}
                            highlightId={highlight}
                            onOpenThread={setThread}
                            onReact={react}
                            onStar={star}
                            onReply={setReplyingTo}
                            onForward={setForwarding}
                            onEdit={setEditing}
                            onDelete={setDeleting}
                        />
                    )}
                </div>

                <TypingLine typists={typists} viewerId={viewerId} />

                {error && (
                    <p role="alert" className="px-4 pb-1 text-xs text-danger">
                        {error}
                    </p>
                )}

                <Composer
                    channelId={channelId}
                    rules={rules}
                    disabled={!canPost}
                    placeholder={
                        canPost
                            ? `Message ${channel.kind === "text" ? `#${channel.name}` : channel.name}`
                            : "This conversation is archived."
                    }
                    editing={editing}
                    replyingTo={replyingTo}
                    onCancelReply={() => setReplyingTo(null)}
                    onCancelEdit={() => setEditing(null)}
                    onSend={send}
                    onMedia={async (address) => {
                        following.current = true;
                        const result = await runAction(
                            () => actions.sendMediaAction(channelId, address),
                            setError
                        );
                        if (!result?.error) {
                            await load();
                            refresh();
                        }
                    }}
                    onSaved={async (savedId) => {
                        following.current = true;
                        const result = await runAction(
                            () => actions.sendSavedMediaAction(channelId, savedId),
                            setError
                        );
                        if (!result?.error) {
                            await load();
                            refresh();
                        }
                    }}
                    onSaveEdit={async (messageId, body) => {
                        await runAction(() => actions.editAction({ messageId, body }), setError);
                        setEditing(null);
                        await load();
                    }}
                />
            </div>

            {searching && !thread && (
                <SearchPanel
                    channelId={channelId}
                    channelName={channel.name}
                    onClose={() => setSearching(false)}
                    onOpen={(hit) => {
                        // A hit in another conversation is a navigation; one in
                        // this conversation is already on screen behind the
                        // panel, and scrolling to it is what a reader expects.
                        if (hit.channelId !== channelId) router.push(`/chat/c/${hit.channelId}`);
                        else void jumpTo(hit.message.id);
                    }}
                />
            )}

            {thread && (
                <ThreadPanel
                    root={thread}
                    rules={rules}
                    viewerId={viewerId}
                    canPost={canPost}
                    canModerate={canModerate}
                    onClose={() => setThread(null)}
                    onChanged={() => void load()}
                />
            )}

            <ForwardDialog
                message={forwarding}
                onOpenChange={(open) => !open && setForwarding(null)}
                onSent={refresh}
            />

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting ? plainExcerpt(deleting.body, 40) : ""}
                kind="message"
                requireTyping={false}
                description={
                    rules.deleteLeavesTrace || (deleting?.replyCount ?? 0) > 0
                        ? "It leaves a line saying it was deleted, so any replies under it still make sense."
                        : "It goes without trace, along with anything attached to it. Nobody is told it was there."
                }
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

/**
 * The way into a voice room, above the conversation that belongs to it.
 *
 * Joining is deliberately a press rather than a consequence of opening the
 * channel. Reading what was said in a room is not the same act as walking into
 * it, and a room that opened a microphone on arrival is one nobody browses.
 */
function VoiceStrip({
    name,
    count,
    onJoin
}: {
    name: string;
    count: number;
    onJoin: (withVideo: boolean) => void;
}) {
    return (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2">
            <Volume2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{name}</span>
                <span className="text-muted-foreground">
                    {count === 0
                        ? " - nobody is in here"
                        : count === 1
                          ? " - one person is in here"
                          : ` - ${count} people are in here`}
                </span>
            </span>
            <Button size="xs" onClick={() => onJoin(false)}>
                <Mic className="size-3.5" />
                Join
            </Button>
            <Button size="xs" variant="secondary" onClick={() => onJoin(true)}>
                <Video className="size-3.5" />
                With video
            </Button>
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
