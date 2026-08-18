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
 * list - a channel made, somebody added, a conversation left. Messages arriving
 * do not go through it: those move `lastMessageAt` and the unread count, which
 * the live frame already brings.
 */

import * as core from "@polaris/core";
import { callsUnavailableAction } from "./meeting-actions";
import {
    chatRulesAction,
    listCategoriesAction,
    listChannelsAction,
    listSpacesAction
} from "./actions";
import type { ChatCategoryView, ChatChannelView, ChatSpaceView } from "@/lib/chat/chat-service";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode
} from "react";

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
    /** The space the rail is standing in, or null for direct messages. Held here
     *  rather than in the rail because two components read it: the column of
     *  spaces and the list beside it. */
    readonly activeSpaceId: string | null;
    readonly setActiveSpaceId: (spaceId: string | null) => void;
    /** False until the first answer arrives, so a rail can tell "nothing yet"
     *  from "nothing at all" and skeleton the first rather than empty-state it. */
    readonly loaded: boolean;
    readonly refresh: () => void;
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
}

const ChatContext = createContext<ChatContextValue | null>(null);

/** How often to ask again while calls are not working. Only while: a working
 *  instance asks once and stops, and a restarting one gets its buttons back
 *  within a few seconds of the media server coming up. */
const CALLS_RECHECK_MS = 8000;

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
    const [channels, setChannels] = useState<readonly ChatChannelView[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [rules, setRules] = useState<Record<core.ChatRuleScope, core.ChatRules> | null>(null);
    const [spaces, setSpaces] = useState<readonly ChatSpaceView[]>([]);
    const [categories, setCategories] = useState<readonly ChatCategoryView[]>([]);
    const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);

    const refresh = useCallback(() => {
        void listChannelsAction()
            .then((result) => setChannels(result.channels))
            .catch(() => {
                // A failed refresh leaves the previous list on screen, which is
                // more use than an empty rail and a red line.
            })
            .finally(() => setLoaded(true));
        // The spaces and their headings move far less often than the channels,
        // but they move for the same reasons - one made, one left - so they are
        // asked for together rather than needing their own signal.
        void listSpacesAction()
            .then((result) => setSpaces(result.spaces))
            .catch(() => undefined);
        void listCategoriesAction()
            .then((result) => setCategories(result.categories))
            .catch(() => undefined);
    }, []);

    useEffect(refresh, [refresh]);

    // Once, when the app opens. The rules are an instance setting: they do not
    // change while somebody is typing, and re-reading them per conversation
    // would be three rows fetched on every navigation.
    useEffect(() => {
        void chatRulesAction()
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
            void callsUnavailableAction()
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
        const timer = setInterval(ask, CALLS_RECHECK_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [may.call, callsAreOff]);

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
            activeSpaceId,
            setActiveSpaceId,
            loaded,
            refresh,
            rulesFor,
            callsOff
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
            activeSpaceId,
            loaded,
            refresh,
            rulesFor,
            callsOff
        ]
    );

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
    const value = useContext(ChatContext);
    if (!value) throw new Error("useChat is only available inside the Chat app");
    return value;
}
