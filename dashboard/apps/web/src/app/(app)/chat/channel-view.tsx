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
import { ThreadPanel } from "./thread-panel";
import { SearchPanel } from "./search-panel";
import { MessageList } from "./message-list";
import { runAction } from "@/lib/run-action";
import { useCallHold } from "./call-session";
import { ForwardDialog } from "./forward-dialog";
import { ChannelHeader } from "./channel-header";
import { useChatStream } from "./use-chat-stream";
import type { RecordedSound } from "./voice-recorder";
import type { ChatMessageView } from "@/lib/chat/messages";
import { useRouter, useSearchParams } from "next/navigation";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { MessageCircle, Mic, Video, Volume2 } from "lucide-react";
import { Button, ConfirmDeleteDialog, EmptyState, Skeleton } from "@polaris/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/** How close to the bottom still counts as "following along". A few pixels of
 *  slack, because a trackpad rarely lands exactly on zero. */
const AT_BOTTOM_SLACK = 60;

/** How long a typing indicator stays up after the last frame about it. Just
 *  longer than the interval the composer sends them at. */
const TYPING_TTL_MS = 4000;

/** Somebody who is mid-something in the box, and when they last said so. */
interface Typist {
    readonly userId: string;
    readonly name: string;
    readonly activity: core.ChatActivity;
    readonly at: number;
}

/** How many pages back a jump to a search hit will walk. Fifty messages a page,
 *  so this reaches a long way without letting one click pull a year of a busy
 *  channel into the browser. */
const JUMP_PAGES = 20;

/** How long the message a search led to stays lit. */
const HIGHLIGHT_MS = 2500;

/**
 * The most messages held at once - four pages.
 *
 * A conversation is read by scrolling, and scrolling far enough would otherwise
 * put the whole of it in the browser: every avatar, every preview card, every
 * player, all still mounted a thousand messages later. So the window moves
 * instead of growing. Four pages is enough that the two edges are well off
 * screen and a fetch is never one flick of a trackpad away.
 */
const MAX_WINDOW = 200;

/** How close to an edge starts the next page loading. Roughly a screenful, so
 *  it arrives before the reader gets there rather than after. */
const NEAR_EDGE = 600;

/** How long a freshly opened conversation keeps putting itself at the bottom
 *  while everything late finishes arriving. */
const SETTLE_MS = 1200;

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
    const params = useSearchParams();
    const { viewerId, channels, refresh, rulesFor } = useChat();
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(null);
    const [pending, setPending] = useState<readonly ChatMessageView[]>([]);
    const [olderThan, setOlderThan] = useState<string | null>(null);
    const [loadingOlder, setLoadingOlder] = useState(false);
    // Whether there is a page below the window too, which there is only after
    // scrolling far enough up that the newest messages were dropped.
    const [newerThan, setNewerThan] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [thread, setThread] = useState<ChatMessageView | null>(null);
    const [searching, setSearching] = useState(false);
    const [highlight, setHighlight] = useState<string | null>(null);
    const [editing, setEditing] = useState<ChatMessageView | null>(null);
    const [deleting, setDeleting] = useState<ChatMessageView | null>(null);
    const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
    const [forwarding, setForwarding] = useState<ChatMessageView | null>(null);
    const [typists, setTypists] = useState<readonly Typist[]>([]);
    const [live, setLive] = useState<{ meetingId: string; count: number } | null>(null);
    // The call this browser is sitting in, held above every screen so that
    // walking out of the conversation shrinks it into a bar rather than hanging
    // up. Being in one is not the same question as one running here: somebody
    // can watch a channel with a call in it without joining, and must not have
    // their camera opened for them.
    const { call, session, enter, leave: leaveCall } = useCallHold();
    const inCall = session?.channelId === channelId ? session.meetingId : null;

    const scroller = useRef<HTMLDivElement>(null);
    // The end of the list, scrolled to rather than computed. `scrollTop =
    // scrollHeight` is arithmetic over a height that is still changing; an
    // element at the bottom is the bottom whatever the height turns out to be,
    // which is what a phone needs - its address bar, its keyboard and its safe
    // areas all resize the viewport after the first paint.
    const foot = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    // How long the list insists on the bottom after a conversation opens.
    // Everything that lands late - pictures, link cards, players, a font - grows
    // it, and the browser's own scroll anchoring moves the position while that
    // happens. Inside this window a scroll that is not somebody's finger does
    // not count as them choosing to read further up.
    const settling = useRef(0);
    const marked = useRef("");
    // Which message each optimistic draft turned into. Reconciling on the id the
    // server gave back rather than on the text is what keeps two people saying
    // "ok" from cancelling each other's draft off the screen.
    const drafts = useRef(0);
    const sent = useRef(new Map<string, string>());
    // The same cursors as `olderThan` and `newerThan`, kept as refs because a
    // jump loads several pages inside one tick and state would still hold the
    // one from before the first of them.
    const olderThanRef = useRef<string | null>(null);
    const newerThanRef = useRef<string | null>(null);
    // What is on screen, as of now rather than as of the last render. The
    // fetches below do arithmetic on the window - what to keep, what to let go
    // of, which id to ask from next - and a state value read inside an awaited
    // function is the one from before the await.
    const held = useRef<readonly ChatMessageView[]>([]);
    // Set just before a page is added above the window, so the layout effect
    // below can put the reader back where they were reading: prepending changes
    // the height of everything above them, and without this the conversation
    // jumps by exactly one page every time it loads one.
    const anchor = useRef<number | null>(null);
    // One fetch at a time in each direction. A trackpad fires scroll events far
    // faster than a round trip.
    const fetching = useRef(false);
    // Whether something arrived while that fetch was in flight.
    //
    // This is what made a message land late. A wake that turned up while any
    // page was being fetched - the one above, the one below, or a previous wake
    // - was dropped and never asked for again, so the message it was about sat
    // there until something else happened to wake the screen. Which is exactly
    // "it arrives, but not straight away".
    const missed = useRef(false);
    const catchUpAgain = useRef<() => void>(() => undefined);
    // The message a link asked for, once it has been walked back to. Kept so a
    // reload of the list - one arrives with every message anybody sends - does
    // not drag the reader back to it over and over.
    const landed = useRef<string | null>(null);

    const channel = useMemo(
        () => channels.find((entry) => entry.id === channelId) ?? null,
        [channels, channelId]
    );
    // What the bar calls this call while somebody is elsewhere in Polaris.
    const callTitle = channel
        ? channel.kind === "text"
            ? `#${channel.name}`
            : channel.name
        : "Call";
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
        marked.current = "";
        following.current = true;
        olderThanRef.current = null;
        newerThanRef.current = null;
        anchor.current = null;
        landed.current = null;
        sent.current.clear();
        setNewerThan(null);
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

    /** Drop everything the server has now confirmed, so a message is never on
     *  screen twice. */
    const settle = useCallback((arrived: readonly ChatMessageView[]) => {
        setPending((current) =>
            current.filter((entry) => {
                const real = sent.current.get(entry.id);
                return !real || !arrived.some((message) => message.id === real);
            })
        );
    }, []);

    /**
     * Let go of the one fetch slot, and answer whatever arrived while it was
     * held.
     *
     * On a timer of zero rather than straight away so the fetch that is
     * finishing gets to run its own tail first - it is still about to write the
     * window it just worked out, and a catch-up that started in the middle of
     * that would be doing arithmetic on a list from a moment ago.
     */
    const release = useCallback(() => {
        fetching.current = false;
        if (!missed.current) return;
        missed.current = false;
        setTimeout(() => catchUpAgain.current(), 0);
    }, []);

    /** The window, written in one place so the fetches below can do their
     *  arithmetic on what is actually on screen without waiting for a render. */
    const show = useCallback((next: readonly ChatMessageView[]) => {
        held.current = next;
        setMessages(next);
    }, []);

    /** Back to the live end of the conversation: the newest page and nothing
     *  else. What opening a channel does. */
    const load = useCallback(async () => {
        const result = await actions.readChannelAction(channelId);
        if (result.error) {
            setError(result.error);
            show([]);
            return;
        }
        const page = result.page?.messages ?? [];
        following.current = true;
        settling.current = Date.now() + SETTLE_MS;
        show(page);
        olderThanRef.current = result.page?.olderThan ?? null;
        newerThanRef.current = null;
        setOlderThan(olderThanRef.current);
        setNewerThan(null);
        settle(page);
    }, [channelId, settle, show]);

    useEffect(() => {
        void load();
    }, [load]);

    /**
     * Pull in the page above the oldest message on screen, and let go of as much
     * from the bottom.
     *
     * The letting go is the point. A conversation somebody reads back through
     * for ten minutes would otherwise hold every message it ever had, each with
     * its avatar, its preview card and its player - which is how a chat tab ends
     * up using a gigabyte on a machine that also has to run everything else.
     * What is dropped is remembered as a cursor, so coming back down brings it
     * straight back.
     *
     * Nothing is trimmed while the reader is at the bottom: dropping what is
     * under somebody's eyes to save memory is the wrong trade in the one place
     * the memory is being spent well.
     *
     * Returns whether there is still more above.
     */
    const loadOlder = useCallback(async (): Promise<boolean> => {
        const cursor = olderThanRef.current;
        if (!cursor || fetching.current) return false;
        fetching.current = true;
        setLoadingOlder(true);

        const result = await actions.readChannelAction(channelId, cursor);
        setLoadingOlder(false);
        release();
        if (!result.page) return false;

        olderThanRef.current = result.page.olderThan;
        setOlderThan(result.page.olderThan);

        // Taken before the list grows above them, so the reader can be put back
        // where they were reading: prepending a page changes the height of
        // everything above, and without this the conversation jumps by exactly
        // one page every time it loads one.
        anchor.current = scroller.current?.scrollHeight ?? null;

        const window = [...result.page.messages, ...held.current];
        if (window.length > MAX_WINDOW && !following.current) {
            const kept = window.slice(0, MAX_WINDOW);
            // What was let go of, so the way back down is one fetch rather than
            // a reload of the whole conversation.
            newerThanRef.current = kept[kept.length - 1]?.id ?? null;
            setNewerThan(newerThanRef.current);
            show(kept);
        } else {
            show(window);
        }
        return result.page.olderThan !== null;
    }, [channelId, release, show]);

    /**
     * The page below the window, for a reader coming back down out of the
     * history. The mirror of the above, trim included: what falls off the top
     * becomes the cursor for going up again.
     */
    const loadNewer = useCallback(async (): Promise<void> => {
        const cursor = newerThanRef.current;
        if (!cursor || fetching.current) return;
        fetching.current = true;

        const result = await actions.readSinceAction(channelId, cursor);
        release();
        if (!result.page) return;

        newerThanRef.current = result.page.newerThan;
        setNewerThan(result.page.newerThan);

        const window = [...held.current, ...result.page.messages];
        if (window.length > MAX_WINDOW) {
            anchor.current = scroller.current?.scrollHeight ?? null;
            const kept = window.slice(window.length - MAX_WINDOW);
            olderThanRef.current = kept[0]?.id ?? null;
            setOlderThan(olderThanRef.current);
            show(kept);
        } else {
            show(window);
        }
        settle(result.page.messages);
    }, [channelId, release, settle, show]);

    /**
     * What has been said since the newest message on screen.
     *
     * Used when a frame says somebody posted. An append rather than a reload:
     * reloading replaces the window with the newest page alone, which throws
     * away the history a reader had walked up into and moves them somewhere they
     * did not ask to be. A reader who is not at the live end is not caught up at
     * all - what arrived is below their window, and it comes back with the rest
     * when they scroll down.
     */
    const catchUp = useCallback(async () => {
        if (newerThanRef.current) return;
        // Remembered rather than dropped. Whoever holds the slot answers this
        // the moment they let go of it, so a message that arrived during a fetch
        // appears a round trip later instead of whenever the screen next has
        // another reason to ask.
        if (fetching.current) {
            missed.current = true;
            return;
        }
        const newest = held.current[held.current.length - 1]?.id ?? null;
        if (!newest) {
            await load();
            return;
        }

        fetching.current = true;
        const result = await actions.readSinceAction(channelId, newest);
        release();
        const arrived = result.page?.messages ?? [];
        if (arrived.length === 0) return;

        const window = [...held.current, ...arrived];
        if (window.length > MAX_WINDOW && following.current) {
            // Following along, so the top is what gives: the reader is at the
            // bottom and the oldest of it is far off screen.
            const kept = window.slice(window.length - MAX_WINDOW);
            olderThanRef.current = kept[0]?.id ?? null;
            setOlderThan(olderThanRef.current);
            show(kept);
        } else {
            show(window);
        }
        settle(arrived);
    }, [channelId, load, release, settle, show]);

    // How `release` reaches back into the catch-up without the two defining each
    // other. Kept fresh every render so it is never the version from before the
    // conversation changed.
    catchUpAgain.current = () => void catchUp();

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

    /**
     * Arrived by answering a call.
     *
     * The card outside the conversation carries the answer in the address rather
     * than joining from where it stands: one place opens a microphone, and it is
     * this one. Taken out of the address as soon as it is acted on, or a reload
     * an hour later would put somebody back into a room they had left.
     */
    const answering = params.get("answer");
    const answered = useRef<string | null>(null);
    useEffect(() => {
        if (!answering || answered.current === answering) return;
        answered.current = answering;
        router.replace(`/chat/c/${channelId}`, { scroll: false });
        void runAction(() => calls.startCallAction(channelId), setError).then((result) => {
            if (result?.meetingId) {
                enter({ meetingId: result.meetingId, channelId, title: callTitle }, false);
            }
            checkCall();
        });
    }, [answering, channelId, router, checkCall, enter, callTitle]);

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
                    void catchUp();
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
                        {
                            userId: frame.userId,
                            name: frame.name,
                            activity: frame.activity ?? "typing",
                            at: Date.now()
                        }
                    ]);
                }
            },
            [channelId, catchUp, checkCall]
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

    // The patches - a star, a reaction, an edit, a delete - change the window
    // without going through `show`, so this is what keeps the two in step.
    useEffect(() => {
        held.current = messages ?? [];
    }, [messages]);

    const shown = useMemo(() => [...(messages ?? []), ...pending], [messages, pending]);

    /** Put the newest message on screen. */
    const stick = useCallback(() => {
        const element = scroller.current;
        if (!element) return;
        element.scrollTop = element.scrollHeight;
        // Twice, and the second one is the one that works on a phone: the block
        // above is right for a list that has finished laying itself out, and
        // this is right for one that has not.
        foot.current?.scrollIntoView({ block: "end" });
    }, []);

    /**
     * Where the reader ends up after the list changes shape.
     *
     * Two cases, and they are opposites. A page added above (or dropped from
     * above) moves everything under it by its own height, so the reader is put
     * back on the line they were reading - that is what `anchor` holds. Anything
     * else, for a reader who was at the bottom, means following the bottom.
     *
     * A layout effect rather than an ordinary one: this runs before the browser
     * paints, so nobody sees the list at the wrong offset first.
     */
    useLayoutEffect(() => {
        const element = scroller.current;
        if (!element) return;
        if (anchor.current !== null) {
            element.scrollTop += element.scrollHeight - anchor.current;
            anchor.current = null;
            return;
        }
        if (following.current) stick();
    }, [shown, stick]);

    /**
     * Stay at the bottom while the conversation is still settling.
     *
     * The reason a reload did not land at the newest message: the list is
     * scrolled the moment it renders, and then the pictures, the link cards and
     * the players finish loading and push it taller. Every one of those is
     * height that appears after the scroll. So while the reader is at the
     * bottom, the bottom is followed as the content grows.
     */
    useEffect(() => {
        const element = scroller.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const watcher = new ResizeObserver(() => {
            if (following.current && anchor.current === null) stick();
        });
        for (const child of element.children) watcher.observe(child);
        return () => watcher.disconnect();
    }, [messages === null, stick]);

    /**
     * Insist, for the first second of a conversation.
     *
     * A phone lays a conversation out several times before it settles - the
     * address bar retracts, a font swaps, every picture arrives - and each of
     * those is height appearing under a list that was already scrolled. One
     * scroll at render is not enough there, which is why it opened part way up.
     */
    useEffect(() => {
        if (messages === null) return;
        let frame = 0;
        const until = settling.current;
        const again = () => {
            if (Date.now() > until || !following.current) return;
            stick();
            frame = requestAnimationFrame(again);
        };
        frame = requestAnimationFrame(again);
        return () => cancelAnimationFrame(frame);
    }, [messages, stick]);

    // Catching up on what is actually on screen.
    useEffect(() => {
        if (!following.current) return;
        const newest = messages?.[messages.length - 1];
        if (!newest || marked.current === newest.id) return;
        marked.current = newest.id;
        void actions.markReadAction({ channelId, messageId: newest.id }).then(refresh);
    }, [messages, channelId, refresh]);

    /**
     * Keep a message, or stop keeping it.
     *
     * Changed in place rather than by reloading the conversation. Reloading it
     * replaced every message on screen, and the list follows the bottom when the
     * reader is at it - so pressing the star threw the reader down the page,
     * away from the message they had just kept. A star is one boolean on one
     * row; nothing else about the conversation changed.
     */
    const star = async (message: ChatMessageView) => {
        const mark = (starred: boolean) =>
            setMessages(
                (current) =>
                    current?.map((entry) =>
                        entry.id === message.id ? { ...entry, starred } : entry
                    ) ?? current
            );

        mark(!message.starred);
        const result = await runAction(() => actions.starAction(message.id), setError);
        // Put it back if the server disagreed, or said nothing at all.
        mark(result?.on ?? message.starred);
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
    const send = async (
        body: string,
        files: readonly File[] = [],
        sounds: readonly RecordedSound[] = []
    ) => {
        if (files.length > 0) {
            following.current = true;
            const form = new FormData();
            form.set("body", body);
            if (replyingTo) form.set("replyToId", replyingTo.id);
            for (const file of files) form.append("files", file);
            // How long each recording is and what it looks like, measured while
            // it was made. Sent as one field in file order rather than one per
            // file, so a message with no recording in it sends nothing.
            if (sounds.length > 0) form.set("sounds", JSON.stringify(sounds));
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

    /**
     * React, in place.
     *
     * Reloading the conversation for one emoji was the same defect the star had:
     * it replaces every message on screen and, now that the screen holds a
     * window rather than the whole channel, it also throws a reader who is up in
     * the history back down to the newest message. The change is one reaction on
     * one row.
     */
    const patchReaction = (messageId: string, emoji: string, mine: boolean) => {
        const apply = (entry: ChatMessageView): ChatMessageView => {
            const existing = entry.reactions.find((entry) => entry.emoji === emoji);
            if ((existing?.mine ?? false) === mine) return entry;
            if (!existing) return { ...entry, reactions: [...entry.reactions, { emoji, count: 1, mine }] };
            const count = existing.count + (mine ? 1 : -1);
            return {
                ...entry,
                reactions: entry.reactions
                    .map((entry) => (entry.emoji === emoji ? { ...entry, count, mine } : entry))
                    .filter((entry) => entry.count > 0)
            };
        };
        setMessages((current) => current?.map((entry) => (entry.id === messageId ? apply(entry) : entry)) ?? current);
    };

    const react = async (messageId: string, emoji: string) => {
        const before =
            held.current
                .find((entry) => entry.id === messageId)
                ?.reactions.find((entry) => entry.emoji === emoji)?.mine ?? false;
        // Said deterministically rather than as a nudge up or down, so putting
        // it back is the same call with the other answer.
        patchReaction(messageId, emoji, !before);
        const result = await runAction(() => actions.reactAction({ messageId, emoji }), setError);
        patchReaction(messageId, emoji, result?.on ?? before);
    };

    /** Change one message on screen, for the things that happen to one message
     *  and must not move anybody's place in the conversation. */
    const patchMessage = (messageId: string, patch: Partial<ChatMessageView>) => {
        setMessages(
            (current) =>
                current?.map((entry) => (entry.id === messageId ? { ...entry, ...patch } : entry)) ?? current
        );
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
                        // Through `runAction`, which is the difference between a
                        // button that says what went wrong and one that appears
                        // to do nothing: an action that throws rather than
                        // returning an error would otherwise reject into
                        // nowhere, and pressing Join would be silence.
                        const result = await runAction(
                            () => calls.startCallAction(channelId),
                            setError
                        );
                        if (!result || result.error) return;
                        if (result.meetingId) {
                            enter(
                                { meetingId: result.meetingId, channelId, title: callTitle },
                                withVideo
                            );
                        } else setError("That call could not be joined. Try again.");
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
                            void runAction(
                                () => calls.startCallAction(channelId),
                                setError
                            ).then((result) => {
                                if (!result || result.error) return;
                                if (result.meetingId) {
                                    enter(
                                        { meetingId: result.meetingId, channelId, title: callTitle },
                                        video
                                    );
                                } else setError("That call could not be joined. Try again.");
                                checkCall();
                            });
                        }}
                    />
                )}

                {inCall && (
                    <div className="flex max-h-[60%] min-h-0 shrink-0 flex-col border-b border-border">
                        <CallRoom
                            call={call}
                            meetingId={inCall}
                            viewerId={viewerId}
                            onLeave={() => {
                                leaveCall();
                                checkCall();
                            }}
                        />
                    </div>
                )}

                <div
                    ref={scroller}
                    onScroll={(event) => {
                        const element = event.currentTarget;
                        const below = element.scrollHeight - element.scrollTop - element.clientHeight;
                        // At the bottom is always "following along". Away from
                        // it only counts once the list has settled: until then
                        // the movement is the page growing under itself, not
                        // somebody deciding to read further up.
                        if (below < AT_BOTTOM_SLACK) following.current = true;
                        else if (Date.now() > settling.current) following.current = false;
                        // Both edges, because the window moves in both
                        // directions: up into the history, and back down out of
                        // it. Each is a no-op when there is no page that way.
                        if (element.scrollTop < NEAR_EDGE) void loadOlder();
                        else if (below < NEAR_EDGE) void loadNewer();
                    }}
                    className="min-h-0 flex-1 overflow-y-auto py-2 [overflow-anchor:none]"
                >
                    {olderThan && (
                        // A line rather than a button. Scrolling is what loads
                        // the next page now; this says the conversation goes
                        // further back, and is what somebody sees for the
                        // moment it takes.
                        <p className="py-2 text-center text-xs text-muted-foreground">
                            {loadingOlder ? "Loading earlier messages" : "Earlier messages"}
                        </p>
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

                    {/* The way back, for somebody who has read a long way up.
                        Scrolling down would work and would take a page at a
                        time; this is one press. */}
                    {newerThan && (
                        <div className="sticky bottom-2 flex justify-center">
                            <button
                                type="button"
                                onClick={() => {
                                    following.current = true;
                                    anchor.current = null;
                                    void load();
                                }}
                                className="rounded-full border border-border bg-elevated px-3 py-1 text-xs shadow-md transition-colors hover:bg-card-hover"
                            >
                                Jump to the newest
                            </button>
                        </div>
                    )}

                    {/* The end of the list, and what "the bottom" means to
                        everything above. Last, after the sticky button, since a
                        sticky element still takes its place in the flow. */}
                    <div ref={foot} aria-hidden="true" />
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
                        const result = await runAction(
                            () => actions.editAction({ messageId, body }),
                            setError
                        );
                        setEditing(null);
                        if (!result?.error) patchMessage(messageId, { body, edited: true });
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
                    onChanged={() => void catchUp()}
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
                        const result = await runAction(
                            () => actions.deleteMessageAction(deleting.id),
                            setError
                        );
                        // The tombstone, exactly as the server draws one: the
                        // line stays and says so, because a conversation whose
                        // replies suddenly answer nothing is worse than one that
                        // admits something was taken back.
                        if (!result?.error) {
                            patchMessage(deleting.id, {
                                body: "",
                                deleted: true,
                                reactions: [],
                                attachments: []
                            });
                        }
                    }
                    setDeleting(null);
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

/**
 * Who is composing right now, and which way.
 *
 * Names rather than "somebody", because in a channel of twelve that is the only
 * version of this line that helps. And recording said as recording: half a
 * minute of nothing from the other side, with no dots because nobody is typing,
 * is indistinguishable from having been left mid-conversation.
 *
 * When the two are mixed the recording wins the sentence. It is the one with a
 * reason to be waited for.
 */
function TypingLine({ typists, viewerId }: { typists: readonly Typist[]; viewerId: string }) {
    const others = typists.filter((entry) => entry.userId !== viewerId);
    if (others.length === 0) return <div className="h-4" aria-hidden="true" />;

    const recording = others.filter((entry) => entry.activity === "recording");
    const shown = recording.length > 0 ? recording : others;
    const doing = recording.length > 0 ? "recording a voice message" : "typing";

    const names =
        shown.length === 1
            ? `${shown[0]!.name} is ${doing}`
            : shown.length === 2
              ? `${shown[0]!.name} and ${shown[1]!.name} are ${doing}`
              : `Several people are ${doing}`;

    return (
        <p aria-live="polite" className="h-4 px-4 text-[11px] text-muted-foreground">
            {names}
        </p>
    );
}
