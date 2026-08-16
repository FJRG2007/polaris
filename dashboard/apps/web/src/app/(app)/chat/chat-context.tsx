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
import { chatRulesAction, listCategoriesAction, listChannelsAction, listSpacesAction } from "./actions";
import type {
    ChatCategoryView,
    ChatChannelView,
    ChatSpaceView
} from "@/lib/chat/chat-service";
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
}

const ChatContext = createContext<ChatContextValue | null>(null);

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
            rulesFor
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
            rulesFor
        ]
    );

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
    const value = useContext(ChatContext);
    if (!value) throw new Error("useChat is only available inside the Chat app");
    return value;
}
