"use client";

/**
 * Who is reading, and the conversation list they are reading it with.
 *
 * The list is held here rather than fetched twice because two screens need it
 * for different reasons: the rail draws it, and the open conversation reads its
 * own name, topic and unread mark out of it. Fetching it in both would mean two
 * requests per navigation and two answers that disagree for a moment.
 *
 * `refresh` is what a screen calls after a write that changes the shape of the
 * list - a channel made, somebody added, a conversation left. Messages and the
 * notices of a DM or group arriving do not go through it: those move
 * `lastMessageAt` (and a message the unread count), which the live frame
 * already brings.
 */

import type { ChatLists } from "@/lib/chat/chat-lists";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import * as core from "@polaris/core";
import { listChannelsAction } from "./actions";
import type { ChatCategoryView, ChatChannelView, ChatSpaceView } from "@/lib/chat/chat-service";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";
import { useRouter } from "next/navigation";
import * as polls from "./chat-reads";

/**
 * What this account may do in the chat beyond reading and writing in it.
 *
 * Four grants that used to come with the app itself. The screen reads them to
 * decide what to draw: a button somebody is not allowed to press is worse than
 * no button, because they press it and are told no by a dialog they opened for
 * nothing. None of this is the enforcement - every one is checked again where it
 * happens - and it is deliberately not treated as if it were.
 */
export interface ChatAllowances {
    /** Start servers. */
    readonly spaces: boolean;
    /** Start a conversation with more than one other person. */
    readonly groups: boolean;
    /** Put files and voice messages in one. */
    readonly attach: boolean;
    /** Be in a call. */
    readonly call: boolean;
    /** Create a meeting anybody holding the link can join. Held by nobody until
     *  an operator grants it - it is the one thing in Chat that reaches outside
     *  Polaris. */
    readonly meetings: boolean;
}

interface ChatContextValue {
    readonly viewerId: string;
    readonly viewerName: string;
    readonly may: ChatAllowances;
    /** The organization shelf this browser is on, or null on the personal one.
     *  What a new space is filed under. */
    readonly orgId: string | null;
    readonly orgName: string | null;
    readonly channels: readonly ChatChannelView[];
    readonly spaces: readonly ChatSpaceView[];
    readonly categories: readonly ChatCategoryView[];
    /**
     * Everybody this reader has blocked, by id.
     *
     * Held here because the roster menu asks about one person at a time and the
     * answer is one small list for the whole app - a lookup per name would be a
     * request every time somebody right-clicks. Never anybody who has blocked
     * this reader: that is not theirs to know, and nothing on the client is ever
     * told it.
     */
    readonly blocked: ReadonlySet<string>;
    /** Everybody this reader is friends with, by id - for the same reason as
     *  `blocked`: a person's menu asks about one person at a time. */
    readonly friends: ReadonlySet<string>;
    /** The space the rail is standing in, or null for direct messages. Held here
     *  rather than in the rail because two components read it: the column of
     *  spaces and the list beside it. */
    readonly activeSpaceId: string | null;
    readonly setActiveSpaceId: (spaceId: string | null) => void;
    /** False until the first answer arrives, so a rail can tell "nothing yet"
     *  from "nothing at all" and skeleton the first rather than empty-state it. */
    readonly loaded: boolean;
    /** The lists on screen are the copy this tab kept, so the rail can draw them
     *  while `loaded` is still false. Only a drawing decision: anything that
     *  decides what the reader may do or see waits for `loaded`. */
    readonly kept: boolean;
    /** The first read has failed and is still being tried. */
    readonly loadFailed: boolean;
    /** Everything above asked for again: the conversations, the spaces, their
     *  headings and who is blocked. What a screen calls after a write that
     *  changes the shape of the list. */
    readonly refresh: () => void;
    /**
     * The conversations alone, asked for again a moment from now.
     *
     * What a message arriving or a conversation being caught up on needs: the
     * order and the unread marks moved, and nothing else did. Calls that land
     * inside the same moment are answered by one request - a busy room is a
     * frame every few hundred milliseconds, and a request per frame is a queue
     * the reader's own sends wait behind.
     */
    readonly refreshChannels: () => void;
    /** What the instance allows in a conversation of a given shape. The
     *  defaults until the answer arrives, so the composer is never briefly
     *  stricter than the server. */
    readonly rulesFor: (channel: { spaceId: string | null; kind: string }) => core.ChatRules;
    /**
     * Why a call cannot be started, or null when one can.
     *
     * Null until the first answer arrives, so nothing flashes as broken while
     * the app opens. The server refuses a call for the same reason either way;
     * this is what stops somebody pressing a button that was never going to
     * work, and what tells them why.
     */
    readonly callsOff: string | null;
    /**
     * Why somebody outside the house could not be reached by a call, or null
     * when they could (or before the first answer). Calls still start: this is
     * a note, not a refusal.
     */
    readonly callsOutside: "cgnat" | "backup" | null;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/** How often to ask again while calls are not working. Only while: a working
 *  instance asks once and stops, and a restarting one gets its buttons back
 *  within a few seconds of the media server coming up. */
const CALLS_RECHECK_MS = 8000;

/** How often to ask whether outsiders can reach a call. The line changes on the
 *  scale of minutes (a relay coming up, a backup flip), never per second. */
const CALLS_OUTSIDE_RECHECK_MS = 60_000;

const LISTS_TIMEOUT_MS = 20_000;
const LISTS_RETRY_CEILING_MS = 30_000;
const KEPT_LISTS_MAX_AGE_MS = 24 * 3_600_000;

interface KeptLists {
    readonly channels: readonly ChatChannelView[];
    readonly spaces: readonly ChatSpaceView[];
    readonly categories: readonly ChatCategoryView[];
}

const keptListsKey = (viewerId: string): string => `chat.lists.${viewerId}`;

/**
 * One read of the lists, or null when the session may not read them, which
 * asking again cannot change. Anything else but a whole answer throws, to be
 * tried again.
 */
async function fetchChatLists(signal: AbortSignal): Promise<ChatLists | null> {
    const response = await fetch("/api/chat/lists", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(LISTS_TIMEOUT_MS)])
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`chat lists answered ${response.status}`);
    const lists = (await response.json()) as ChatLists;
    // Without the conversations there is no rail to draw, however far the rest got.
    if (!lists.channels) throw new Error("chat lists came back without conversations");
    return lists;
}

/** Sooner at first, then every LISTS_RETRY_CEILING_MS for as long as the tab is open. */
function waitToRetry(failures: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(2000 * 2 ** failures, LISTS_RETRY_CEILING_MS));
        const stop = () => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener("abort", stop, { once: true });
    });
}

/** How long a burst of arrivals is gathered before the conversations are asked
 *  for again. Short enough that a new message moves the list while somebody is
 *  still looking at where it landed; long enough that a room talking quickly is
 *  one request rather than one per message. */
export const CHANNELS_SETTLE_MS = 300;

export function ChatProvider({
    viewerId,
    viewerName,
    orgId,
    orgName,
    may,
    children
}: {
    viewerId: string;
    viewerName: string;
    orgId: string | null;
    orgName: string | null;
    may: ChatAllowances;
    children: ReactNode;
}) {
    const router = useRouter();
    const [channels, setChannels] = useState<readonly ChatChannelView[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [kept, setKept] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [rules, setRules] = useState<Record<core.ChatRuleScope, core.ChatRules> | null>(null);
    const [spaces, setSpaces] = useState<readonly ChatSpaceView[]>([]);
    const [categories, setCategories] = useState<readonly ChatCategoryView[]>([]);
    const [blocked, setBlocked] = useState<ReadonlySet<string>>(() => new Set());
    const [friends, setFriends] = useState<ReadonlySet<string>>(() => new Set());
    const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);

    const keptLists = useRef<KeptLists | null>(null);
    const keepLists = useCallback(
        (lists: KeptLists) => {
            keptLists.current = lists;
            writeSnapshot(keptListsKey(viewerId), lists);
        },
        [viewerId]
    );

    const attempt = useRef<AbortController | null>(null);
    const backoff = useRef<AbortController | null>(null);
    const askAgain = useRef(false);
    const refresh = useCallback(() => {
        // One request for all of them. The spaces and their headings move far
        // less often than the channels, but they move for the same reasons - one
        // made, one left - and blocking somebody changes what the roster offers
        // and what the list draws, so all of them ride this one signal rather
        // than needing their own.
        //
        // A plain request rather than a server action, timed out and tried again:
        // the router's action queue has no timeout, so one action that never
        // settled kept this list a skeleton until the page was reloaded.
        //
        // A read already running is left to finish and followed by one more:
        // these calls arrive once per stream frame, and cancelling it for each
        // would let a busy moment stop every read from ever landing.
        if (attempt.current) {
            askAgain.current = true;
            backoff.current?.abort();
            return;
        }
        const current = new AbortController();
        attempt.current = current;
        const apply = (result: ChatLists) => {
            // A part that could not be read comes back null and leaves the
            // previous one on screen, which is more use than an empty rail
            // and a red line.
            if (result.channels) setChannels(result.channels);
            if (result.spaces) setSpaces(result.spaces);
            if (result.categories) setCategories(result.categories);
            if (result.blocked) setBlocked(new Set(result.blocked));
            if (result.friends) setFriends(new Set(result.friends));
            if (result.channels && result.spaces && result.categories) {
                keepLists({
                    channels: result.channels,
                    spaces: result.spaces,
                    categories: result.categories
                });
            }
            setLoaded(true);
            setLoadFailed(false);
        };
        void (async () => {
            let failures = 0;
            while (!current.signal.aborted) {
                askAgain.current = false;
                try {
                    const lists = await fetchChatLists(current.signal);
                    if (current.signal.aborted) return;
                    if (!lists) {
                        // The server's own gates decide where this session goes.
                        setLoadFailed(true);
                        router.refresh();
                        break;
                    }
                    apply(lists);
                    failures = 0;
                    if (!askAgain.current) break;
                } catch {
                    if (current.signal.aborted) return;
                    setLoadFailed(true);
                    if (!askAgain.current) {
                        backoff.current = new AbortController();
                        await waitToRetry(
                            failures,
                            AbortSignal.any([current.signal, backoff.current.signal])
                        );
                    }
                    failures += 1;
                }
            }
            if (attempt.current === current) attempt.current = null;
        })();
    }, [keepLists, router]);

    const channelsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refreshChannels = useCallback(() => {
        if (channelsTimer.current) return;
        channelsTimer.current = setTimeout(() => {
            channelsTimer.current = null;
            void listChannelsAction()
                .then((result) => {
                    setChannels(result.channels);
                    if (keptLists.current) {
                        keepLists({ ...keptLists.current, channels: result.channels });
                    }
                })
                .catch(() => {
                    // The previous list stays, as it does for a full refresh.
                });
        }, CHANNELS_SETTLE_MS);
    }, [keepLists]);

    useEffect(
        () => () => {
            if (channelsTimer.current) clearTimeout(channelsTimer.current);
            channelsTimer.current = null;
        },
        []
    );

    // Before the paint, so a reload never flashes the skeleton over a rail it has.
    useLayoutEffect(() => {
        const lists =
            readSnapshot<KeptLists>(keptListsKey(viewerId), KEPT_LISTS_MAX_AGE_MS)?.value ?? null;
        keptLists.current = lists;
        if (!lists) return;
        setChannels(lists.channels);
        setSpaces(lists.spaces);
        setCategories(lists.categories);
        setKept(true);
    }, [viewerId]);
    useEffect(() => {
        refresh();
        return () => {
            attempt.current?.abort();
            attempt.current = null;
        };
    }, [refresh]);

    // Once, when the app opens. The rules are an instance setting: they do not
    // change while somebody is typing, and re-reading them per conversation
    // would be three rows fetched on every navigation.
    useEffect(() => {
        void polls
            .chatRules()
            .then((result) => setRules(result.rules))
            .catch(() => {
                // Left null, which reads as the defaults. The server enforces
                // the real ones either way; this only decides what the composer
                // warns about.
            });
    }, []);

    /**
     * Whether calls work at all, asked once and then only while they do not.
     *
     * The media server starts with the stack and takes a moment to come up, so
     * "not yet" is a state a browser can sit in for the first minute after a
     * restart. Re-asking only in that state is what lets the buttons come back
     * on their own, without every open tab knocking on it forever afterwards.
     */
    const [callsOff, setCallsOff] = useState<string | null>(null);
    // Whether, not why. The effect below turns on this rather than on the
    // sentence, so a reworded answer does not restart the timer.
    const callsAreOff = callsOff !== null;

    useEffect(() => {
        if (!may.call) return;
        let stopped = false;
        const ask = (): void => {
            void polls
                .callsUnavailable()
                .then((reason) => {
                    if (!stopped) setCallsOff(reason);
                })
                .catch(() => {
                    // Left as it was. A question that could not be asked is not
                    // an answer, and reading it as "calls are off" would take
                    // the buttons away over one failed request.
                });
        };
        ask();
        if (!callsAreOff) {
            return () => {
                stopped = true;
            };
        }
        // Not while the tab is hidden: nobody is looking, and it reads once on
        // the way back instead.
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") ask();
        }, CALLS_RECHECK_MS);
        const onReturn = (): void => {
            if (document.visibilityState === "visible") ask();
        };
        document.addEventListener("visibilitychange", onReturn);
        return () => {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onReturn);
        };
    }, [may.call, callsAreOff]);

    const [callsOutside, setCallsOutside] = useState<"cgnat" | "backup" | null>(null);

    useEffect(() => {
        if (!may.call) return;
        let stopped = false;
        const ask = (): void => {
            void polls
                .callsOutside()
                .then((reason) => {
                    if (!stopped) setCallsOutside(reason);
                })
                .catch(() => {
                    // Left as it was: a failed question is not an answer.
                });
        };
        ask();
        // Not while the tab is hidden: nobody is looking, and it reads once on
        // the way back instead.
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") ask();
        }, CALLS_OUTSIDE_RECHECK_MS);
        const onReturn = (): void => {
            if (document.visibilityState === "visible") ask();
        };
        document.addEventListener("visibilitychange", onReturn);
        return () => {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onReturn);
        };
    }, [may.call]);

    const rulesFor = useCallback(
        (channel: { spaceId: string | null; kind: string }) =>
            rules?.[core.chatRuleScopeOf(channel)] ?? core.DEFAULT_CHAT_RULES,
        [rules]
    );

    const value = useMemo(
        () => ({
            viewerId,
            viewerName,
            may,
            orgId,
            orgName,
            channels,
            spaces,
            categories,
            blocked,
            friends,
            activeSpaceId,
            setActiveSpaceId,
            loaded,
            kept,
            loadFailed,
            refresh,
            refreshChannels,
            rulesFor,
            callsOff,
            callsOutside
        }),
        [
            viewerId,
            viewerName,
            may,
            orgId,
            orgName,
            channels,
            spaces,
            categories,
            blocked,
            friends,
            activeSpaceId,
            loaded,
            kept,
            loadFailed,
            refresh,
            refreshChannels,
            rulesFor,
            callsOff,
            callsOutside
        ]
    );

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
    const value = useContext(ChatContext);
    if (!value) throw new Error("useChat is only available inside the Chat app");
    return value;
}
