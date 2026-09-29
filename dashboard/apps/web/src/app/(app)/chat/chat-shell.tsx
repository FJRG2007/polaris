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

import { ServerRail } from "./server-rail";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ChatSidebar } from "./chat-sidebar";
import { usePathname } from "next/navigation";
import { useChatPane } from "./use-chat-pane";
import { useChatStream } from "./use-chat-stream";
import { resetPaneLayout } from "./pane-preferences";
import { PAGE_BLEED, ResizeHandle } from "@polaris/ui";
import { useCallback, type CSSProperties, type ReactNode } from "react";
import { ChatProvider, useChat, type ChatAllowances } from "./chat-context";

/**
 * What the conversation list may be narrowed and widened to.
 *
 * The lower limit is where a row stops being readable - a name and a preview of
 * what was said, which is what the list is for. The upper one is where the
 * conversation beside it starts being the narrow column instead, on the smallest
 * screen this list is drawn on at all.
 */
const LIST_PANE = { min: 208, max: 480, fallback: 256 };

/**
 * Whether this address is a conversation, which on a phone takes the whole
 * screen. Opening one with somebody counts: that page either becomes the
 * conversation or says why it cannot, and a hidden column says nothing.
 */
export function conversationOnScreen(pathname: string): boolean {
    return pathname.startsWith("/chat/c/") || pathname.startsWith("/chat/with/");
}

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
    const t = useTranslations("chat");
    const pathname = usePathname();
    const { refresh, refreshChannels, viewerId } = useChat();
    // Written as it moves, not on release: a drag that ends by closing the tab
    // is still a decision somebody made. The window can spare less than the
    // list may be, and a width remembered from a wide screen arrives on a
    // narrow one unchanged - which is what the ceiling holds it to.
    const { drawn, ceiling, measure, resize, reset } = useChatPane("list", LIST_PANE);
    // Inside a conversation on a phone the list steps aside; on anything wider
    // both are shown, which is why this decides a class rather than a render.
    const inConversation = conversationOnScreen(pathname);

    useChatStream(
        useCallback(
            (frame) => {
                // A membership change moves the list itself, and the spaces
                // and headings with it: everything is asked for again. Answered
                // by asking rather than patching - the alternative is teaching
                // the client to apply every kind of change to a shape the
                // server already knows how to build.
                if (frame.kind === "channels") refresh();
                // A message moves the order and the unread marks and nothing
                // else, so only the conversations are asked for - and a burst of
                // them once, a moment later. The spaces, their headings and who
                // is blocked cannot have moved because somebody talked, and
                // asking for them on every message was three requests in the
                // queue the reader's own sends wait behind.
                if (frame.kind === "posted") refreshChannels();
                // Caught up by this same person, wherever they did it - a phone,
                // another tab, or the conversation open beside this rail.
                // Nothing arrived, but the counts here are no longer true, and
                // before this they stayed up until the page was reloaded. The one
                // trigger on purpose: the screen that performed the read is told
                // by this frame like every other, so it does not ask for the list
                // again on its own. Somebody else catching up changes nothing
                // here, and is only ever announced to them and the one person
                // whose ticks it moves.
                if (frame.kind === "read" && frame.userId === viewerId) refreshChannels();
            },
            [refresh, refreshChannels, viewerId]
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
            {/* The width rides a custom property rather than the class, because
                on a phone this column takes whatever the rail of spaces leaves
                and a remembered desktop width would be wrong in both directions.
                `flex-1`, not `w-full`: a full width beside the rail is the rail's
                width wider than the screen, and the right edge of every row - when
                the last message arrived, the unread count - went off it. */}
            <div
                ref={measure}
                style={{ "--chat-list": `${drawn}px` } as CSSProperties}
                className={`${inConversation ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col border-r border-border md:w-[var(--chat-list)] md:flex-none`}
            >
                <ChatSidebar />
            </div>
            {/* Only where there are two columns to divide. On a phone one of them
                is always the whole screen, so there is no line to move. */}
            <ResizeHandle
                axis="x"
                size={drawn}
                min={LIST_PANE.min}
                max={ceiling}
                onChange={resize}
                onReset={reset}
                onResetAll={resetPaneLayout}
                label={t("shell.conversationListWidth")}
                className="hidden md:block"
            />
            <div
                className={`${inConversation ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col`}
            >
                {children}
            </div>
        </div>
    );
}
