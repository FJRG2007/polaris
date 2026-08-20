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

import { PAGE_BLEED } from "@polaris/ui";
import { ServerRail } from "./server-rail";
import { ChatSidebar } from "./chat-sidebar";
import { usePathname } from "next/navigation";
import { useChatStream } from "./use-chat-stream";
import { useCallback, type ReactNode } from "react";
import { ChatProvider, useChat, type ChatAllowances } from "./chat-context";

export function ChatShell({
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
    /** What this account is allowed to do beyond talking, resolved once by the
     *  layout. The screens read it to decide what to offer; every one of them is
     *  checked again where it happens. */
    may: ChatAllowances;
    children: ReactNode;
}) {
    return (
        <ChatProvider
            may={may}
            orgId={orgId}
            orgName={orgName}
            viewerId={viewerId}
            viewerName={viewerName}
        >
            <ChatColumns>{children}</ChatColumns>
        </ChatProvider>
    );
}

function ChatColumns({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const { refresh, viewerId } = useChat();
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
                // Caught up by this same person, wherever they did it - a phone,
                // another tab, or the conversation open beside this rail.
                // Nothing arrived, but the counts here are no longer true, and
                // before this they stayed up until the page was reloaded. The one
                // trigger on purpose: the screen that performed the read is told
                // by this frame like every other, so it does not ask for the list
                // again on its own. Somebody else catching up changes nothing
                // here, and is only ever announced to them and the one person
                // whose ticks it moves.
                if (frame.kind === "read" && frame.userId === viewerId) refresh();
            },
            [refresh, viewerId]
        )
    );

    return (
        // Edge to edge: Chat draws its own rails, headers and panels, and a
        // page's margin around all of that is a strip of unused background on
        // four sides. No `w-full` - see PAGE_BLEED.
        <div className={`${PAGE_BLEED} flex flex-row`}>
            {/* The column of spaces stays on a phone while the list is showing,
                and steps aside with it once a conversation is open - on a narrow
                screen the conversation gets the whole width. */}
            <div className={`${inConversation ? "hidden md:flex" : "flex"} min-h-0 shrink-0`}>
                <ServerRail />
            </div>
            <div
                className={`${inConversation ? "hidden md:flex" : "flex"} min-h-0 w-full shrink-0 flex-col border-r border-border md:w-64`}
            >
                <ChatSidebar />
            </div>
            <div
                className={`${inConversation ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col`}
            >
                {children}
            </div>
        </div>
    );
}
