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

import { listChannelsAction } from "./actions";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode
} from "react";

interface ChatContextValue {
    readonly viewerId: string;
    readonly viewerName: string;
    /** The organization shelf this browser is on, or null on the personal one.
     *  What a new space is filed under. */
    readonly orgId: string | null;
    readonly orgName: string | null;
    readonly channels: readonly ChatChannelView[];
    /** False until the first answer arrives, so a rail can tell "nothing yet"
     *  from "nothing at all" and skeleton the first rather than empty-state it. */
    readonly loaded: boolean;
    readonly refresh: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({
    viewerId,
    viewerName,
    orgId,
    orgName,
    children
}: {
    viewerId: string;
    viewerName: string;
    orgId: string | null;
    orgName: string | null;
    children: ReactNode;
}) {
    const [channels, setChannels] = useState<readonly ChatChannelView[]>([]);
    const [loaded, setLoaded] = useState(false);

    const refresh = useCallback(() => {
        void listChannelsAction()
            .then((result) => setChannels(result.channels))
            .catch(() => {
                // A failed refresh leaves the previous list on screen, which is
                // more use than an empty rail and a red line.
            })
            .finally(() => setLoaded(true));
    }, []);

    useEffect(refresh, [refresh]);

    const value = useMemo(
        () => ({ viewerId, viewerName, orgId, orgName, channels, loaded, refresh }),
        [viewerId, viewerName, orgId, orgName, channels, loaded, refresh]
    );

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
    const value = useContext(ChatContext);
    if (!value) throw new Error("useChat is only available inside the Chat app");
    return value;
}
