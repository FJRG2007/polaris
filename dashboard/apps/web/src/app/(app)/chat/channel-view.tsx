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

import { useConfirm } from "@/components/confirm-dialog";
import { useVoiceSettings } from "./voice-settings";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { Composer } from "./composer";
import type { PollDraft } from "./poll-dialog";
import { CallRoom } from "./call-room";
import { threadRootFor } from "./links";
import { useChat } from "./chat-context";
import * as calls from "./meeting-actions";
import { ThreadPanel } from "./thread-panel";
import { SearchPanel } from "./search-panel";
import { channelDraftKey } from "./drafts";
import { MessageList } from "./message-list";
import { runAction } from "@/lib/run-action";
import { useCallHold } from "./call-session";
import { ChannelHeader } from "./channel-header";
import { useChatStream } from "./use-chat-stream";
import type { RecordedSound } from "./voice-recorder";
import type * as messagesLib from "@/lib/chat/messages";
import type { ChatMessageView } from "@/lib/chat/messages";
import { useRouter, useSearchParams } from "next/navigation";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { ChannelMembers, useMembersPanel } from "./members-panel";
import { posterFor } from "./video-poster";
import { ScheduledBar } from "./scheduled-bar";
import { DirectProfile } from "./direct-profile";
import type { ScheduledMessageView } from "@/lib/chat/scheduled";
import { ForwardDialog } from "./forward-dialog";
import { ArrowDown, Loader2, MessageCircle, Mic, Video, Volume2 } from "lucide-react";
import { Button, ConfirmDeleteDialog, EmptyState, Skeleton, cn } from "@polaris/ui";
import { unblockPersonAction } from "@/app/(app)/account/privacy/actions";
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

/** How long to wait for a frame in a tab that is not drawing any. */
const FRAME_TIMEOUT_MS = 50;

/**
 * One drawn frame.
 *
 * A page added to the window is state until React has put it in the document,
 * and anything that looks for an element it has just fetched has to wait for
 * that or it is searching the list from before. A hidden tab paints nothing, so
 * the timer is what keeps a jump made in a background tab from hanging.
 */
function drawn(): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, FRAME_TIMEOUT_MS);
        requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

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
    const { viewerId, channels, refresh, rulesFor, may, callsOff } = useChat();
    const [unblocking, setUnblocking] = useState(false);
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
    const members = useMembersPanel();
    const [highlight, setHighlight] = useState<string | null>(null);
    // The same, for a message a link led to that turned out to be a reply: it is
    // pointed at inside the thread panel rather than in the channel.
    const [threadHighlight, setThreadHighlight] = useState<string | null>(null);
    const [editing, setEditing] = useState<ChatMessageView | null>(null);
    const [deleting, setDeleting] = useState<ChatMessageView | null>(null);
    const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
    const [forwarding, setForwarding] = useState<ChatMessageView | null>(null);
    /**
     * A message said somewhere else, brought here to be answered.
     *
     * What "reply privately" leaves behind: the conversation with that person is
     * opened, and this is what the bar above the box is about. It is not a reply
     * in the data sense - a reply belongs to the conversation its parent is in,
     * and this one deliberately is not - so it travels as a quote, which is the
     * same movement forwarding already makes. What changes is only how it reads:
     * a reply bar with the room it came from named on it, rather than a dialog.
     */
    const [carried, setCarried] = useState<messagesLib.CarriedMessage | null>(null);
    /** Something to drop into the box from outside it - a name pressed in the
     *  roster. The token is what says "again", since the same name twice is two
     *  mentions and the text alone cannot tell them apart. */
    const [inserting, setInserting] = useState<{ token: number; text: string } | null>(null);
    const [typists, setTypists] = useState<readonly Typist[]>([]);
    // How much arrived below somebody who is reading further up. They are not
    // dragged to it - that is the one thing a chat must not do to somebody
    // mid-sentence - but they are told, and one press takes them there.
    const [unseen, setUnseen] = useState(0);
    const [live, setLive] = useState<{ meetingId: string; count: number } | null>(null);
    // The call this browser is sitting in, held above every screen so that
    // walking out of the conversation shrinks it into a bar rather than hanging
    // up. Being in one is not the same question as one running here: somebody
    // can watch a channel with a call in it without joining, and must not have
    // their camera opened for them.
    const { call, session, enter, leave: leaveCall, withVideo } = useCallHold();
    const inCall = session?.channelId === channelId ? session.meetingId : null;
    // Joining a room while already in a call replaces the call, which is the one
    // thing here nobody can undo. Whether to ask first is this browser's own
    // setting - see `voice-settings`.
    const [voice] = useVoiceSettings();
    const [confirm, confirmElement] = useConfirm();
    /**
     * The voice channel this browser has already walked into.
     *
     * Set before the joining starts, not after, and that is the whole of the
     * bookkeeping: it stops a second attempt while the address is still being
     * rewritten, and it stops somebody who left a room they are still looking at
     * from being put straight back into it.
     */
    const walkedIn = useRef<string | null>(null);
    const [joining, setJoining] = useState(false);
    /** Whoever is being answered privately while their conversation is being
     *  found, or null. The ref is the guard against a second press, the name is
     *  what the line under the list says - see `replyPrivately`. */
    const opening = useRef<string | null>(null);
    const [openingName, setOpeningName] = useState<string | null>(null);
    // Whether a picture in the call has the big place, which the room says
    // rather than this screen guessing: what is being watched depends on what
    // somebody in there asked for. It goes back on its own when they stop.
    const [staged, setStaged] = useState(false);

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

    /**
     * Pick the conversation up again from a message.
     *
     * The rail is asked again straight after, because that is where the outcome
     * is: the badge coming back on the conversation is the only thing on screen
     * that says this worked. Nothing here scrolls or navigates - somebody
     * marking a message unread is saying "later", not "take me away from it" -
     * and the catch-up that would undo it only runs when a new message arrives
     * while the list is at the bottom.
     */
    const markUnread = async (message: ChatMessageView) => {
        const result = await runAction(
            () => actions.markUnreadAction({ channelId, messageId: message.id }),
            setError
        );
        if (!result?.error) refresh();
    };

    /** Let them through again, from the bar that replaced the composer. The rail
     *  is asked again rather than patched: `blocked` is carried on the
     *  conversation, and this screen reads it from there. */
    const letThemThrough = async () => {
        const other = channel?.others[0];
        if (!other) return;
        setUnblocking(true);
        const result = await runAction(() => unblockPersonAction({ userId: other.id }), setError);
        setUnblocking(false);
        if (!result?.error) refresh();
    };
    const canModerate = channel?.mayModerate ?? false;
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
        setUnseen(0);
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

        // Below the fold for somebody reading further up. Counted rather than
        // scrolled to, and shown as a press at the bottom of the list.
        if (!following.current) setUnseen((current) => current + arrived.length);

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

    /** Scroll to a message that is already drawn, and light it. */
    const landOn = useCallback((messageId: string): boolean => {
        const element = document.getElementById(`message-${messageId}`);
        if (!element) return false;
        following.current = false;
        // The conversation has stopped settling, whatever the clock says. This
        // is what a link to a message was fighting: the first second after a
        // conversation opens, the list insists on the bottom every frame, so
        // landing on an older message inside that second was undone before
        // anybody saw it - the message was pointed at and the screen was at the
        // newest line.
        settling.current = 0;
        element.scrollIntoView({ block: "center" });
        setHighlight(messageId);
        setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
        return true;
    }, []);

    /**
     * A message that was never in the channel's own list, opened where it does
     * live: under the root of its thread.
     *
     * A reply is not in the channel - the list leaves it out on purpose, so its
     * root's reply count is the only thing pointing at it - which means walking
     * backwards for one can only ever end in "not found". A link to a reply is
     * an ordinary thing to be handed, though: a mention inside a thread, a
     * message toast, a reported message. So the last question the jump asks is
     * the server's: is this a reply, or is it really out of reach.
     *
     * Answers whether it opened one.
     */
    const openThreadOf = useCallback(async (messageId: string): Promise<boolean> => {
        const result = await actions.readThreadAction(messageId);
        const root = threadRootFor(result.messages ?? [], messageId);
        if (!root) return false;
        setThread(root);
        setThreadHighlight(messageId);
        setTimeout(() => setThreadHighlight(null), HIGHLIGHT_MS);
        return true;
    }, []);

    /**
     * Scroll to a message, fetching backwards until it is there.
     *
     * A search hit is usually older than the screenful the channel opened on, so
     * "scroll to it" means "load until it exists". Bounded, because a hit from
     * two years ago would otherwise walk the whole conversation into the browser
     * one page at a time.
     *
     * Each pass waits for a frame before it looks. A page that has just been
     * fetched is state until React has drawn it, and this used to look before
     * that: the walk stopped the moment a fetch said there was nothing further
     * above, without ever searching the page it had just brought in. Which is
     * how a link to a message sitting on screen answered that it was further
     * back than this could reach.
     */
    const jumpTo = useCallback(
        async (messageId: string) => {
            for (let attempt = 0; attempt < JUMP_PAGES; attempt += 1) {
                await drawn();
                if (landOn(messageId)) return;
                if (!olderThanRef.current) break;
                await loadOlder();
            }
            if (await openThreadOf(messageId)) return;
            setError("That message is further back than this can reach.");
        },
        [landOn, loadOlder, openThreadOf]
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

    /**
     * Arrived to answer somebody privately.
     *
     * The message is named in the address for the same reason a call answer is:
     * getting here is a navigation, and a navigation carries nothing but its
     * address. It is fetched rather than passed, because it was said in a room
     * this screen has never loaded - and it is fetched through the server, which
     * checks that whoever is asking can read that room before it hands over a
     * word of it.
     *
     * Taken out of the address as soon as it is acted on, so a reload tomorrow
     * does not put the bar back over an empty box.
     */
    const quoting = params.get("quote");
    const quoted = useRef<string | null>(null);
    useEffect(() => {
        if (!quoting || quoted.current === quoting) return;
        quoted.current = quoting;
        router.replace(`/chat/c/${channelId}`, { scroll: false });
        void runAction(() => actions.carriedMessageAction(quoting), setError).then((result) => {
            if (result?.carried) setCarried(result.carried);
        });
    }, [channelId, quoting, router]);

    // Leaving the conversation drops it. What is on the bar is about this box in
    // this room; carrying it to the next one would offer to answer a stranger's
    // message in a conversation that has nothing to do with it.
    //
    // On a change of conversation and never on arriving at one: the effect above
    // strips the address as soon as it has read it, which re-runs everything
    // here with no quote in it - and a reset that fired then would wipe the
    // message it had just gone and fetched.
    const lastRoom = useRef(channelId);
    useEffect(() => {
        if (lastRoom.current === channelId) return;
        lastRoom.current = channelId;
        setCarried(null);
        quoted.current = null;
    }, [channelId]);

    // The message being answered, taken back while the box was open.
    //
    // The server refuses the reply - answering something that is no longer there
    // would land a quote of a tombstone - so the bar over the composer goes as
    // soon as the deletion arrives, rather than waiting for somebody to finish
    // typing and be told no.
    useEffect(() => {
        if (!replyingTo || !messages) return;
        const still = messages.find((entry) => entry.id === replyingTo.id);
        if (still?.deleted) setReplyingTo(null);
    }, [messages, replyingTo]);

    // A link straight to a message. Waits for the first page rather than racing
    // it: the message may well be on it, and walking backwards from an empty
    // list would ask for pages that are already on the way.
    //
    // And waits for the channel, which arrives from the rail's own fetch. Until
    // it does this screen is a skeleton with no list in it, so a jump that
    // started here searched a document the messages were not in yet and gave up
    // on the first pass.
    useEffect(() => {
        if (!channel || !messageId || messages === null || landed.current === messageId) return;
        landed.current = messageId;
        void jumpTo(messageId);
    }, [channel, messageId, messages, jumpTo]);

    /**
     * A link to a message in this same conversation, followed without leaving it.
     *
     * The address of a message is the conversation's with the message on the
     * end, so pressing one quoted here is a navigation to the room already open:
     * it unmounts this screen, fetches the conversation again and redraws every
     * line of it, to arrive where scrolling gets in a frame. The reader sees the
     * room they were reading blink out and come back.
     *
     * So the scroll happens instead, and the address is written rather than
     * navigated to - the line is still what a copied URL or a reload lands on,
     * which is the whole of what the route was giving. Written and not pushed:
     * this is the same page it already was, and a back button that walks through
     * every message somebody glanced at is not a history anybody wants.
     */
    const jumpHere = useCallback(
        (target: string) => {
            window.history.replaceState(null, "", `/chat/c/${channelId}/${target}`);
            // Whatever the address says now has been landed on, so the effect
            // above does not walk back to it a second time.
            landed.current = target;
            void jumpTo(target);
        },
        [channelId, jumpTo]
    );

    /**
     * The ticks, asked for again.
     *
     * The other person read the conversation. Nothing about the messages
     * changed, so reloading is the wrong tool: it replaces every message on
     * screen and takes a reader who had walked up into the history back down to
     * the newest line. Only this reader's own messages that are not already
     * read are asked about, so a group channel - where there are no ticks at
     * all - asks nothing.
     *
     * Capped at what one request may carry, newest first. The window is only
     * trimmed while the reader is at the live end, so somebody reading further up
     * while a conversation runs holds more than that - and a list one over the
     * limit is refused whole, which stopped the ticks moving at all with nothing
     * on screen to say why.
     */
    const freshenReceipts = useCallback(async () => {
        const waiting = held.current
            .filter(
                (entry) =>
                    entry.authorId === viewerId &&
                    entry.receipt !== null &&
                    entry.receipt !== "read"
            )
            .map((entry) => entry.id)
            .slice(-core.MAX_CHAT_RECEIPTS);
        if (waiting.length === 0) return;

        const { receipts } = await actions.receiptsAction({ channelId, messageIds: waiting });
        if (Object.keys(receipts).length === 0) return;
        setMessages(
            (current) =>
                current?.map((entry) =>
                    receipts[entry.id] ? { ...entry, receipt: receipts[entry.id]! } : entry
                ) ?? current
        );
    }, [channelId, viewerId]);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind === "posted" && frame.channels.includes(channelId)) {
                    void catchUp();
                    checkCall();
                }
                // Somebody caught up in here. Their own screens take a count
                // down; this one moves the ticks under its own messages, which
                // used to sit on "sent" until the conversation was reopened.
                if (
                    frame.kind === "read" &&
                    frame.channelId === channelId &&
                    frame.userId !== viewerId
                ) {
                    void freshenReceipts();
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

    /**
     * Answer whoever wrote a message, privately.
     *
     * The conversation with them is opened first and the dialog only after, so
     * somebody whose direct messages that person does not accept is told before
     * they have written anything rather than after. It is a find rather than a
     * create where one already exists, which is why there is nothing here about
     * whether they have spoken before.
     *
     * That round trip is the reason for `opening`. Between the menu closing and
     * the dialog appearing there was nothing on screen at all, so on a slow
     * answer the item read as broken and got pressed again - which is a second
     * conversation being asked for. It says who is being answered while it
     * waits, and the second press does nothing until the first has landed.
     */
    const replyPrivately = useCallback(
        async (message: ChatMessageView) => {
            const authorId = message.authorId;
            if (!authorId) return;
            if (opening.current) return;
            opening.current = authorId;
            setOpeningName(message.authorName ?? "them");
            const result = await runAction(
                () => actions.openDirectAction({ userIds: [authorId] }),
                setError
            );
            opening.current = null;
            setOpeningName(null);
            if (!result || result.error || !result.id) return;
            // Straight there, with the message named in the address. That
            // conversation draws its own bar from it - see `carried` - so answering
            // privately ends up looking exactly like answering anything else, which
            // is the whole point: a dialog with a box of its own was a second way to
            // write a message, and people already know the first one.
            router.push(`/chat/c/${result.id}?quote=${message.id}`);
        },
        [router]
    );

    /**
     * Walk into a voice channel, because somebody pressed it.
     *
     * A voice channel is a room: pressing its name is how somebody says they
     * want to be in it, and asking them to press a second button inside is a
     * step that exists for no reason they can see. It is also what every other
     * client does, so the button was a difference nobody was asking for.
     *
     * The cost is real and worth naming: it opens a microphone on a press. What
     * keeps that from being frightening is that the room remembers whether this
     * browser was muted last time and joins that way - see `call-muted` - so
     * somebody who mutes once stays muted every time after.
     *
     * **The press travels in the address, and is taken out of it once acted on.**
     * The same arrangement the answer above uses, and for the same reason. Read
     * off the screen being open instead, "pressed the room" and "have the room
     * on screen" are one fact, and they are not: reloading the page put somebody
     * straight back into a call they had just left, a link opened in a second tab
     * joined from an address alone, and a browser reopening yesterday's windows
     * opened a microphone in a room nobody had touched that morning. Reading what
     * was said in a room is not the same act as walking into it - and for the
     * times it is, the strip above the conversation is one press.
     *
     * It never happens to somebody already in a call, wherever that call is.
     * `enter` replaces whatever this browser was in, so walking in would mean
     * that opening a voice channel to see who is in it hangs up the conversation
     * you are having - silently. While a call is held, the strip's button is the
     * way in, and moving rooms stays deliberate.
     */
    const pressed = params.get("join");
    useEffect(() => {
        // Waited for rather than guessed: which kind of room this is decides
        // whether there is anything to walk into, and the list arrives a moment
        // after the screen does.
        if (!pressed || !channel || walkedIn.current === channelId) return;
        walkedIn.current = channelId;
        router.replace(`/chat/c/${channelId}`, { scroll: false });
        if (channel.kind !== "voice" || callsOff || session) return;

        setJoining(true);
        void runAction(() => calls.startCallAction(channelId), setError).then((result) => {
            setJoining(false);
            if (!result || result.error) return;
            if (!result.meetingId) {
                setError("That room could not be opened. Try again.");
                return;
            }
            // Without a camera, whoever they are: a voice channel is voice, and
            // the camera is one press away inside it.
            enter({ meetingId: result.meetingId, channelId, title: callTitle }, false);
            checkCall();
        });
    }, [callTitle, callsOff, channel, channelId, checkCall, enter, pressed, router, session]);

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

    /**
     * Catching up on what is actually on screen.
     *
     * Called rather than only watched, because being at the live end is a ref and
     * a ref changes without a render. Pressing "3 new messages" on a whole window
     * scrolls and nothing else - the list it marks is the list it already had - so
     * an effect on the messages alone left the reader looking straight at the
     * newest line with the channel still bold in the rail. Scrolling back down by
     * hand is the same moment.
     *
     * The rail is not refreshed here. The read is announced, and this tab is in
     * that frame's audience like every other screen this person has open, so
     * asking for the list again as well is the same three queries twice.
     */
    const catchUpMark = useCallback(() => {
        if (!following.current) return;
        const newest = held.current[held.current.length - 1];
        if (!newest || marked.current === newest.id) return;
        marked.current = newest.id;
        void actions.markReadAction({ channelId, messageId: newest.id });
    }, [channelId]);

    useEffect(catchUpMark, [messages, catchUpMark]);

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
    /**
     * What this reader has waiting here.
     *
     * Read when the conversation opens and again whenever one is added, sent or
     * taken back - never on a timer. The list only changes because this browser
     * changed it, or because the hour came and the message became an ordinary
     * message, which arrives on the stream like any other.
     */
    const [scheduled, setScheduled] = useState<readonly ScheduledMessageView[]>([]);
    const loadScheduled = useCallback(async () => {
        const result = await actions.listScheduledAction(channelId);
        setScheduled(result.scheduled ?? []);
    }, [channelId]);

    useEffect(() => {
        setScheduled([]);
        void loadScheduled();
    }, [loadScheduled]);

    /**
     * The same message, written down for later.
     *
     * Two doors, exactly as sending has: text goes through the action, and files
     * go through the route that can write bytes - the bytes have to be on storage
     * before the hour comes, since the browser holding them will be closed.
     */
    const scheduleMessage = async (
        sendAt: string,
        body: string,
        files: readonly File[]
    ): Promise<{ error?: string }> => {
        const answering = replyingTo?.id ?? null;
        if (files.length > 0) {
            const form = new FormData();
            form.set("body", body);
            form.set("sendAt", sendAt);
            if (answering) form.set("replyToId", answering);
            for (const file of files) form.append("files", file);
            for (const file of files) {
                const still = await posterFor(file).catch(() => null);
                form.append("posters", still ?? new Blob([], { type: "image/jpeg" }));
            }
            const response = await fetch(`/api/chat/channels/${channelId}/scheduled`, {
                method: "POST",
                body: form
            });
            if (!response.ok) {
                const answer: unknown = await response.json().catch(() => null);
                const message =
                    typeof answer === "object" && answer !== null && "error" in answer
                        ? String((answer as { error: unknown }).error)
                        : "That could not be scheduled";
                return { error: message };
            }
        } else {
            const result = await actions.scheduleMessageAction({
                channelId,
                body,
                replyToId: answering,
                forwarded: false,
                sendAt
            });
            if (result.error) return { error: result.error };
        }
        // The bar it answers comes down with it, the way it does when a reply is
        // sent: what was written is no longer pending an answer.
        setReplyingTo(null);
        setCarried(null);
        await loadScheduled();
        return {};
    };

    /**
     * Ask a question with answers under it.
     *
     * The bar the composer is showing is honoured the same way a scheduled
     * message honours it, and comes down only once the poll has actually gone:
     * the dialog stays open on a refusal, and clearing the reply under it would
     * leave somebody looking at an error with the thing they were answering
     * already forgotten.
     */
    const createPoll = async (draft: PollDraft): Promise<{ error?: string }> => {
        following.current = true;
        const result = await actions.createPollAction({
            channelId,
            ...draft,
            replyToId: replyingTo?.id ?? null
        });
        if (result.error) return { error: result.error };
        setReplyingTo(null);
        setCarried(null);
        await load();
        refresh();
        return {};
    };

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
            // A still per video, in the same order as the files and with an
            // empty one standing in for everything that is not a video - so the
            // two lists line up on the other side without either of them
            // carrying an index. Taken here rather than on the server: the
            // bytes are already in this browser, and the alternative is a
            // transcoder on the machine Polaris runs on.
            for (const file of files) {
                const still = await posterFor(file).catch(() => null);
                form.append("posters", still ?? new Blob([], { type: "image/jpeg" }));
            }
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

    /**
     * What the composer's bar is pointing at, taken and put down.
     *
     * The bar means "the next thing sent answers this", and until now only
     * typing honoured it: a GIF or a saved picture chosen from the picker sent
     * itself as an unrelated message and left the bar standing, so the note
     * typed after it answered something the reader believed they had already
     * replied to.
     *
     * The two cases the bar can be showing are the two `messages.send` already
     * knows how to quote: a message in this room, which is a reply, and one
     * carried in from another, which is a forward - and a picture is as good a
     * note on a forward as a sentence.
     */
    const takeReply = (): { messageId: string; forwarded: boolean } | null => {
        const answering = replyingTo
            ? { messageId: replyingTo.id, forwarded: false }
            : carried
              ? { messageId: carried.message.id, forwarded: true }
              : null;
        setReplyingTo(null);
        setCarried(null);
        return answering;
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
            // A draft is always a line of text. A poll is written in a dialog
            // and posted from there, so there is nothing on screen for an
            // optimistic one to replace.
            poll: null,
            quote: null,
            starred: false,
            // Nobody blocks themselves, and the menu that would offer it does
            // not appear on your own row.
            blocked: false,
            // Resolved by the server on the reload a moment from now. A draft
            // that guessed would draw a card and then replace it with a
            // different one.
            references: [],
            // Your own words, which your own setting never stands between you and.
            forwardable: true,
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
        // A message said in another room cannot be a reply here - a reply belongs
        // to the conversation its parent is in - so it goes the way forwarding
        // goes: quoted, with what was typed as the note on top. The bar above the
        // box reads as a reply either way, which is the only part anybody sees.
        const elsewhere = !replyingTo && carried ? carried.message.id : null;
        // Cleared before the round trip: the bar is about what is being written,
        // and the message has left.
        setReplyingTo(null);
        setCarried(null);

        const result = await runAction(
            () =>
                elsewhere
                    ? actions.forwardAction({ messageId: elsewhere, channelId, note: body })
                    : actions.sendAction({ channelId, body, replyToId: answering }),
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
            if (!existing)
                return { ...entry, reactions: [...entry.reactions, { emoji, count: 1, mine }] };
            const count = existing.count + (mine ? 1 : -1);
            return {
                ...entry,
                reactions: entry.reactions
                    .map((entry) => (entry.emoji === emoji ? { ...entry, count, mine } : entry))
                    .filter((entry) => entry.count > 0)
            };
        };
        setMessages(
            (current) =>
                current?.map((entry) => (entry.id === messageId ? apply(entry) : entry)) ?? current
        );
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
                current?.map((entry) =>
                    entry.id === messageId ? { ...entry, ...patch } : entry
                ) ?? current
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

    /** A voice room this browser is standing in. The call is what the column is
     *  for while that is true, and the conversation moves to the side of it. */
    const voiceRoom = channel?.kind === "voice" && inCall !== null;

    /**
     * The conversation itself: what has been said, and the box to say more in.
     *
     * Bound rather than written where it is drawn, because it is drawn in two
     * different places. In a voice room the call is what the column is for and
     * this goes down the side of it, which is what every client that has both
     * does - a room and its record are two things to look at, not one above the
     * other with neither of them tall enough to read.
     */
    const conversation = (
        <>
            <div
                ref={scroller}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    const below = element.scrollHeight - element.scrollTop - element.clientHeight;
                    // At the bottom is always "following along". Away from
                    // it only counts once the list has settled: until then
                    // the movement is the page growing under itself, not
                    // somebody deciding to read further up.
                    if (below < AT_BOTTOM_SLACK) {
                        following.current = true;
                        // Back at the live end, so nothing is waiting below
                        // and everything on screen has now been seen.
                        setUnseen(0);
                        catchUpMark();
                    } else if (Date.now() > settling.current) following.current = false;
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
                        onMarkUnread={markUnread}
                        onJumpTo={jumpHere}
                        onReply={setReplyingTo}
                        // Not in a direct message, where every reply is
                        // already private and the item would do nothing
                        // anybody could tell apart from Reply.
                        onReplyPrivately={
                            channel?.kind === "dm"
                                ? undefined
                                : (message) => void replyPrivately(message)
                        }
                        onForward={setForwarding}
                        onEdit={setEditing}
                        onDelete={setDeleting}
                        // The same box the roster's menu writes into, so a name
                        // mentioned from the messages lands where one mentioned
                        // from the column does.
                        onMention={(text) =>
                            setInserting((current) => ({
                                token: (current?.token ?? 0) + 1,
                                text
                            }))
                        }
                    />
                )}

                {/* The way back, for somebody who has read a long way up.
                            Scrolling down would work and would take a page at a
                            time; this is one press.

                            Also what a message arriving below the fold gets. A reader
                            mid-way up the history is not dragged to the newest line -
                            that is the one thing a conversation must not do to
                            somebody reading - but before this they were not told
                            either, so a message that had arrived was a message they
                            found later by accident. */}
                {(newerThan || unseen > 0) && (
                    <div className="sticky bottom-2 flex justify-center">
                        <button
                            type="button"
                            onClick={() => {
                                following.current = true;
                                anchor.current = null;
                                setUnseen(0);
                                // A window that has been trimmed has to fetch
                                // its way back; one that is whole only has to
                                // scroll, and reloading it would throw away
                                // the history above. Either way the reader is
                                // now at the newest message, which is a read
                                // nothing else would report - scrolling does
                                // not change the list a fetch would.
                                if (newerThan) void load();
                                else {
                                    stick();
                                    catchUpMark();
                                }
                            }}
                            className="flex items-center gap-1.5 rounded-full border border-border bg-elevated px-3 py-1 text-xs shadow-md transition-colors hover:bg-card-hover"
                        >
                            <ArrowDown className="size-3" />
                            {unseen === 0
                                ? "Jump to the newest"
                                : unseen === 1
                                  ? "1 new message"
                                  : `${unseen} new messages`}
                        </button>
                    </div>
                )}

                {/* The end of the list, and what "the bottom" means to
                            everything above. Last, after the sticky button, since a
                            sticky element still takes its place in the flow. */}
                <div ref={foot} aria-hidden="true" />
            </div>

            <TypingLine typists={typists} viewerId={viewerId} />

            {/* The wait, while there is one. Counted down rather than
                        discovered: a room that refuses a paragraph after it has
                        been written is a room people write paragraphs in twice.
                        Nobody who may moderate sees this, because it does not
                        apply to them. */}
            {!canModerate && (
                <SlowmodeLine
                    seconds={channel?.slowmode ?? 0}
                    lastSentAt={
                        [...shown].reverse().find((message) => message.authorId === viewerId)
                            ?.createdAt ?? null
                    }
                />
            )}

            {openingName && (
                <p className="flex items-center gap-1.5 px-4 pb-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3 shrink-0 animate-spin" />
                    Opening your conversation with {openingName}
                </p>
            )}

            {error && (
                <p role="alert" className="px-4 pb-1 text-xs text-danger">
                    {error}
                </p>
            )}

            {channel.blocked ? (
                /* A conversation with somebody this reader blocked. The box is
                   replaced rather than disabled: a greyed-out composer says
                   "not now" and leaves them looking for why, and the way out of
                   this one is a decision rather than a wait. */
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
                    <p className="text-xs text-muted-foreground">
                        You blocked {channel.name}. They cannot reach you, and you cannot write to
                        them.
                    </p>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={unblocking}
                        onClick={() => void letThemThrough()}
                    >
                        Unblock
                    </Button>
                </div>
            ) : (
                <>
                    {/* Above the box rather than in the room: what is waiting is
                        not a message yet, and the only person it concerns is the
                        one who wrote it. Nothing at all when nothing is. */}
                    <ScheduledBar
                        scheduled={scheduled}
                        onSendNow={async (id) => {
                            const result = await actions.sendScheduledNowAction(id);
                            if (result.error) setError(result.error);
                            await loadScheduled();
                            await load();
                            refresh();
                        }}
                        onCancel={async (id) => {
                            const result = await actions.cancelScheduledAction(id);
                            if (result.error) setError(result.error);
                            await loadScheduled();
                        }}
                    />
                    <Composer
                        channelId={channelId}
                        // The chat's own announcement, handed in: the box is also
                        // the one under a task, where there is nobody to tell.
                        onTyping={(kind) => void actions.typingAction(channelId, kind)}
                        // Kept for next time. A conversation is still here
                        // tomorrow, whether it is a channel, a group or one
                        // person - see `drafts`.
                        draftKey={channelDraftKey(channelId)}
                    rules={rules}
                    disabled={!canPost}
                    attachable={may.attach}
                    placeholder={
                        canPost
                            ? `Message ${channel.kind === "text" ? `#${channel.name}` : channel.name}`
                            : "This conversation is archived."
                    }
                    editing={editing}
                    replyingTo={replyingTo ?? carried?.message ?? null}
                    replyingFrom={
                        carried?.from ? { name: carried.from, channel: carried.channel } : null
                    }
                    insert={inserting}
                    onCancelReply={() => {
                        setReplyingTo(null);
                        setCarried(null);
                    }}
                    onCancelEdit={() => setEditing(null)}
                    onSend={send}
                    onSchedule={scheduleMessage}
                    onPoll={createPoll}
                    onMedia={async (address) => {
                        following.current = true;
                        // The picture answers whatever the bar was pointing at, and
                        // the bar comes down as it is sent - the same two halves a
                        // typed reply gets. Without them a GIF chosen with a reply
                        // open landed as an unrelated message and left the bar up,
                        // so the next thing typed answered something the reader had
                        // already replied to.
                        const answering = takeReply();
                        const result = await runAction(
                            () => actions.sendMediaAction(channelId, address, null, answering),
                            setError
                        );
                        if (!result?.error) {
                            await load();
                            refresh();
                        }
                    }}
                    onSaved={async (savedId) => {
                        following.current = true;
                        const answering = takeReply();
                        const result = await runAction(
                            () => actions.sendSavedMediaAction(channelId, savedId, answering),
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
                </>
            )}
        </>
    );

    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 overflow-hidden",
                // Beside the room on anything wide enough to read two things at
                // once, underneath it otherwise. A column of eighty pixels of
                // conversation on a phone is not a conversation.
                voiceRoom && "flex-col lg:flex-row"
            )}
        >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <ChannelHeader
                    channel={channel}
                    viewerId={viewerId}
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
                    // In a conversation with a roster this opens it; in a
                    // one-to-one it opens the other person, which is what the
                    // column beside a direct message is for.
                    onMembers={members.toggle}
                />

                {/* A voice channel is a room AND a record: the one place a
                    group is most likely to want to drop a link used to be the
                    one place it could not.

                    Opening the channel walks in on its own, so this is only
                    what is left when that cannot happen - calls switched off,
                    a room that refused to open, or the moment in between. */}
                {channel.kind === "voice" && !inCall && (
                    <VoiceStrip
                        name={channel.name}
                        count={live?.count ?? 0}
                        off={callsOff}
                        busy={joining}
                        onJoin={async (video) => {
                            // Joining here while already in a call somewhere else
                            // replaces that call - silently, which is fine when it
                            // is what somebody meant and is the one thing they
                            // cannot undo when it is not. Asked only of readers
                            // who turned the warning on; see `voice-settings`.
                            if (session && voice.switchWarning) {
                                const sure = await confirm({
                                    title: `Leave your call and join ${channel.name}?`,
                                    description:
                                        "You are in a call now, and Polaris holds one at a time - joining this room hangs that one up.",
                                    confirmLabel: "Join this room"
                                });
                                if (!sure) return;
                            }
                            void runAction(() => calls.startCallAction(channelId), setError).then(
                                (result) => {
                                    if (!result || result.error) return;
                                    if (result.meetingId) {
                                        enter(
                                            {
                                                meetingId: result.meetingId,
                                                channelId,
                                                title: callTitle
                                            },
                                            video
                                        );
                                    } else setError("That call could not be joined. Try again.");
                                    checkCall();
                                }
                            );
                        }}
                    />
                )}

                {inCall && (
                    <div
                        className={cn(
                            "flex min-h-0 shrink-0 flex-col border-b border-border",
                            // A picture worth watching changes what this column
                            // is for. At the usual height a shared screen got a
                            // third of 60% of the column - about a hand's width
                            // of somebody's document - and "make it bigger"
                            // could not make it bigger, because the room it
                            // would take was being held for messages nobody was
                            // reading while a screen was up.
                            voiceRoom ? "flex-1" : staged ? "max-h-[78%]" : "max-h-[60%]"
                        )}
                    >
                        <CallRoom
                            call={call}
                            meetingId={inCall}
                            viewerId={viewerId}
                            onStage={setStaged}
                            onLeave={() => {
                                leaveCall();
                                checkCall();
                            }}
                            // A one-to-one that took a third person is a group
                            // now, and the call is in it. This browser started
                            // that, so nothing will tell it - it follows on the
                            // answer, with the camera it already had.
                            onMoved={(to) => {
                                enter(
                                    {
                                        meetingId: to.meetingId,
                                        channelId: to.channelId,
                                        title: callTitle
                                    },
                                    withVideo
                                );
                                router.push(`/chat/c/${to.channelId}`);
                            }}
                        />
                    </div>
                )}

                {/* Down the side in a voice room - see `conversation`. */}
                {!voiceRoom && conversation}
            </div>

            {/* The record of a voice room, beside the room rather than under
                it. Narrow on purpose: it is the place a link gets dropped
                while people are talking, not the thing being looked at. */}
            {voiceRoom && (
                <aside className="flex min-h-0 w-full shrink-0 flex-col border-t border-border lg:w-80 lg:border-l lg:border-t-0">
                    {conversation}
                </aside>
            )}

            {/* One side panel at a time on the right, and the roster is the one
                that yields: a thread and a search are things somebody is doing,
                the roster is something that is there. */}
            {channel.kind === "dm" && !thread && !searching && (
                <DirectProfile
                    person={channel.others[0] ?? null}
                    channel={channel}
                    open={members.open}
                    onOpenChange={members.setOpen}
                    onMention={(text) =>
                        setInserting((current) => ({ token: (current?.token ?? 0) + 1, text }))
                    }
                />
            )}

            {channel.kind !== "dm" && !thread && !searching && (
                <ChannelMembers
                    channel={channel}
                    open={members.open}
                    onOpenChange={members.setOpen}
                    onMention={(text) =>
                        setInserting((current) => ({ token: (current?.token ?? 0) + 1, text }))
                    }
                />
            )}

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
                    highlightId={threadHighlight}
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
                                attachments: [],
                                // Everything the body was carrying goes with
                                // it. The server resolves all four from the
                                // text, and a tombstone has no text - so a
                                // voice room card, a link preview or a forward
                                // left on screen is this browser showing what
                                // the message said after it was taken back,
                                // until somebody reloads.
                                references: [],
                                link: null,
                                preview: null,
                                previewPending: false,
                                forwardable: false
                            });
                        }
                    }
                    setDeleting(null);
                    router.refresh();
                }}
            />
            {confirmElement}
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
    onJoin,
    off,
    busy = false
}: {
    name: string;
    count: number;
    onJoin: (withVideo: boolean) => void | Promise<void>;
    /** Why nobody can walk in right now, or null. A voice room whose way in is
     *  a button that fails is a room people press twice and then give up on. */
    off: string | null;
    /** Already on the way in. Said rather than left blank: a room that takes a
     *  second to open, with a Join button still sitting there, is a room people
     *  press twice. */
    busy?: boolean;
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
            {off ? (
                <span className="text-xs text-muted-foreground">{off}</span>
            ) : busy ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                    Going in
                </span>
            ) : (
                <>
                    <Button size="xs" onClick={() => void onJoin(false)}>
                        <Mic className="size-3.5" />
                        Join
                    </Button>
                    <Button size="xs" variant="secondary" onClick={() => void onJoin(true)}>
                        <Video className="size-3.5" />
                        With video
                    </Button>
                </>
            )}
        </div>
    );
}

/**
 * How long this reader still has to wait, counted down.
 *
 * The arithmetic is shared with the server - see `slowmodeWait` - so the number
 * on screen is the number the send path will refuse on, rather than a second
 * guess that disagrees with it by a second and makes a liar of one of them.
 *
 * Drawn from the last message of this reader's that is currently loaded. Somebody
 * who has scrolled far enough up that their own last message fell out of the
 * window sees no countdown and is refused once, which is the honest failure: the
 * alternative is a query per keystroke to tell them something they will know in a
 * moment anyway.
 */
function SlowmodeLine({ seconds, lastSentAt }: { seconds: number; lastSentAt: string | null }) {
    const [left, setLeft] = useState(0);

    useEffect(() => {
        if (seconds <= 0 || !lastSentAt) {
            setLeft(0);
            return;
        }
        const sentAt = new Date(lastSentAt);
        const tick = () =>
            setLeft(core.slowmodeWait({ slowmode: seconds, lastSentAt: sentAt, now: new Date() }));
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [lastSentAt, seconds]);

    if (left <= 0) return null;
    return (
        <p className="px-4 pb-1 text-xs text-muted-foreground">
            Slow mode is on here. You can send again in {core.slowmodeSpoken(left)}.
        </p>
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
        <p aria-live="polite" className="h-4 px-4 text-[0.6875rem] text-muted-foreground">
            {names}
        </p>
    );
}
