"use client";

/**
 * The two columns Chat is read in.
 *
 * The conversation list on the left is the app's own rail - Chat has no entry in
 * APP_SECTIONS on purpose, because a rail of two fixed links above a list of
 * live conversations would be two navigations stacked on each other.
 *
 * Full height and its own scrolling. A chat that scrolled the page would put the
 * composer below the fold the moment a conversation got long, which is the one
 * control that must never move.
 *
 * On a phone the two columns become one: the list, until a conversation is
 * picked, and then the conversation with a way back. Showing a 15rem rail beside
 * a 4rem message column helps nobody.
 */

import { ChatSidebar } from "./chat-sidebar";
import { usePathname } from "next/navigation";
import { useChatStream } from "./use-chat-stream";
import { useCallback, type ReactNode } from "react";
import { ChatProvider, useChat } from "./chat-context";

export function ChatShell({
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
    return (
        <ChatProvider viewerId={viewerId} viewerName={viewerName} orgId={orgId} orgName={orgName}>
            <ChatColumns>{children}</ChatColumns>
        </ChatProvider>
    );
}

function ChatColumns({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const { refresh } = useChat();
    // Inside a conversation on a phone the list steps aside; on anything wider
    // both are shown, which is why this decides a class rather than a render.
    const inConversation = pathname.startsWith("/chat/c/");

    useChatStream(
        useCallback(
            (frame) => {
                // A message moves the order and the unread marks, and a
                // membership change moves the list itself. Both are answered by
                // asking for the list again - it is one small query, and the
                // alternative is teaching the client to apply every kind of
                // change to a shape the server already knows how to build.
                if (frame.kind === "posted" || frame.kind === "channels") refresh();
            },
            [refresh]
        )
    );

    return (
        <div className="flex h-below-header w-full overflow-hidden">
            <div
                className={`${inConversation ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r border-border md:w-64`}
            >
                <ChatSidebar />
            </div>
            <div className={`${inConversation ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
                {children}
            </div>
        </div>
    );
}
