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

import { LiveLocationBar } from "./live-location-bar";
import { ServerRail } from "./server-rail";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ChatSidebar } from "./chat-sidebar";
import { ChatLockProvider } from "./lock-dialogs";
import { usePathname, useRouter } from "next/navigation";
import { usePhone } from "@/components/use-phone";
import { useOwnBottomTabs } from "@/components/phone-tabs-owner";
import { MessageSquare, Server, Video } from "lucide-react";
import { phoneChatTab, phoneTabBadges, type PhoneChatTab } from "./phone-chat";
import { useChatPane } from "./use-chat-pane";
import { paneWidthFor } from "./list-view";
import { useChatStream } from "./use-chat-stream";
import { resetPaneLayout } from "./pane-preferences";
import { BottomTabs, PAGE_BLEED, ResizeHandle } from "@polaris/ui";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { useRef, useMemo, useState, useCallback, type CSSProperties, type ReactNode } from "react";
import { ChatProvider, useChat, type ChatAllowances } from "./chat-context";
import * as readMarks from "@/lib/chat/read-marks";

/**
 * What the conversation list may be narrowed and widened to.
 *
 * The lower limit is where a row stops being readable - a name and a preview of
 * what was said, which is what the list is for. The upper one is where the
 * conversation beside it starts being the narrow column instead, on the smallest
 * screen this list is drawn on at all.
 */
const LIST_PANE = { min: 208, max: 560, fallback: 256 };

/**
 * Whether somebody else catching up in this conversation can change its row:
 * only while the row ends on the reader's own message, with ticks, not yet read.
 * A conversation not in the list yet is asked for, since nothing says otherwise.
 */
export function tickMayMove(channels: readonly ChatChannelView[], channelId: string): boolean {
    const row = channels.find((channel) => channel.id === channelId);
    if (!row) return true;
    return Boolean(row.last?.receipts && !row.last.read);
}

/** The same question for the second tick: a row whose own last message is still
 *  short of delivered. Pure. */
export function deliveryMayMove(channels: readonly ChatChannelView[], channelId: string): boolean {
    const row = channels.find((channel) => channel.id === channelId);
    if (!row) return true;
    return Boolean(row.last?.receipts && !row.last.delivered && !row.last.read);
}

/**
 * Whether this address is a conversation, which on a phone takes the whole
 * screen. Opening one with somebody counts: that page either becomes the
 * conversation or says why it cannot, and a hidden column says nothing. So do
 * the pages drawn in that column with a back arrow of their own - the saved
 * messages, a space's emoji, the meetings and a meeting's room - which on a
 * phone were a hidden column too.
 */
export function conversationOnScreen(pathname: string): boolean {
    return (
        pathname.startsWith("/chat/c/") ||
        pathname.startsWith("/chat/with/") ||
        pathname.startsWith("/chat/s/") ||
        pathname === "/chat/meetings" ||
        pathname.startsWith("/chat/meetings/") ||
        pathname === "/chat/saved"
    );
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
    const { channels, refresh, refreshChannels, viewerId, spaces, activeSpaceId, setActiveSpaceId } =
        useChat();
    const router = useRouter();
    const phone = usePhone();
    // Read from the frame handler without re-subscribing on every list change.
    const rows = useRef(channels);
    rows.current = channels;
    // Written as it moves, not on release: a drag that ends by closing the tab
    // is still a decision somebody made. The window can spare less than the
    // list may be, and a width remembered from a wide screen arrives on a
    // narrow one unchanged - which is what the ceiling holds it to.
    const { drawn, ceiling, measure, resize, reset } = useChatPane("list", LIST_PANE);
    // Inside a conversation on a phone the list steps aside; on anything wider
    // both are shown, which is why this decides a class rather than a render.
    const inConversation = conversationOnScreen(pathname);
    // A phone's three places, WhatsApp's tab bar: which one is open is read off
    // the address and the space the rail stands in - see `phoneChatTab`. Only
    // somebody in no space at all needs Servers remembered on its own.
    const [serversPicked, setServersPicked] = useState(false);
    const lastSpace = useRef<string | null>(null);
    if (activeSpaceId) lastSpace.current = activeSpaceId;
    const tab = phoneChatTab(pathname, activeSpaceId, serversPicked);
    const calls = pathname === "/chat/meetings";
    // Inside a conversation the conversation owns the screen; the meetings list
    // is the Calls tab, not a conversation, so the bar stays under it.
    // Chat draws its own tabs, and none at all inside a conversation, so the
    // shell's bar steps aside for the whole app.
    useOwnBottomTabs();
    const tabsShown = phone && (!inConversation || calls);
    const badges = useMemo(() => phoneTabBadges(channels), [channels]);
    const chooseTab = (next: PhoneChatTab): void => {
        if (next === "calls") {
            router.push("/chat/meetings");
            return;
        }
        if (next === "chats") {
            setServersPicked(false);
            setActiveSpaceId(null);
        } else {
            const target =
                spaces.find((space) => space.id === lastSpace.current)?.id ?? spaces[0]?.id ?? null;
            if (target) setActiveSpaceId(target);
            else setServersPicked(true);
        }
        if (calls) router.push("/chat");
    };
    // On a phone the rail of spaces is the Servers tab's, not furniture beside
    // every list; from `sm` up it is what it always was.
    const railClass = phone
        ? tab === "servers" && !inConversation
            ? "flex"
            : "hidden"
        : inConversation
          ? "hidden md:flex"
          : "flex";
    const noServers = phone && tab === "servers" && activeSpaceId === null;

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
                // again on its own. Somebody else catching up can only move the
                // tick on this reader's own last message in that row, so it is
                // asked for only while that row has a tick still short of read.
                if (frame.kind === "read") {
                    // Put back to unread on purpose, here or on another device:
                    // what this tab read ahead of the server no longer stands.
                    if (frame.userId === viewerId && frame.unread)
                        readMarks.forgetReadMark(frame.channelId);
                    if (frame.userId === viewerId) refreshChannels();
                    else if (tickMayMove(rows.current, frame.channelId)) refreshChannels();
                }
                // Somebody's device picked a message up: only a row whose tick
                // is still a single one has anything to change.
                if (frame.kind === "delivered" && deliveryMayMove(rows.current, frame.channelId))
                    refreshChannels();
            },
            [refresh, refreshChannels, viewerId]
        ),
        // The connection dropped and came back - a phone waking up, a network
        // that blinked. Every frame in between is gone, so the list is read
        // again rather than left in the order it had before the gap.
        refresh
    );

    return (
        // Edge to edge: Chat draws its own rails, headers and panels, and a
        // page's margin around all of that is a strip of unused background on
        // four sides. No `w-full` - see PAGE_BLEED. The lock wraps both columns:
        // the open conversation reads how long its unlock lasts from it.
        <ChatLockProvider>
            <div className={`${PAGE_BLEED} flex flex-col`}>
                <div className="flex min-h-0 min-w-0 flex-1 flex-row">
                    {/* The column of spaces: on a phone, the Servers tab's, beside
                    that space's channels; on a narrow screen it steps aside with the
                    list once a conversation is open, which gets the whole width. */}
                    <div
                        data-tour="chat.spaces"
                        className={`${railClass} min-h-0 shrink-0`}
                    >
                        <ServerRail browse={phone} />
                    </div>
                    {/* The width rides a custom property rather than the class, because
                    on a phone this column takes whatever the rail of spaces leaves
                    and a remembered desktop width would be wrong in both directions.
                    `flex-1`, not `w-full`: a full width beside the rail is the rail's
                    width wider than the screen, and the right edge of every row - when
                    the last message arrived, the unread count - went off it. */}
                    <div
                        ref={measure}
                        data-tour="chat.conversations"
                        style={{ "--chat-list": `${drawn}px` } as CSSProperties}
                        className={`${inConversation ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col border-e border-border md:w-[var(--chat-list)] md:flex-none`}
                    >
                        <LiveLocationBar />
                        {noServers ? (
                            <p className="px-4 py-6 text-sm text-muted-foreground">
                                {t("phoneTabs.noServers")}
                            </p>
                        ) : (
                            <ChatSidebar
                                onListView={(view) => {
                                    const width = paneWidthFor(view, drawn, ceiling);
                                    if (width !== null) resize(width);
                                }}
                            />
                        )}
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
                        data-tour="chat.conversation"
                        className={`${inConversation ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col`}
                    >
                        {children}
                    </div>
                </div>
                {/* The app shell's bar steps aside for this one (useOwnBottomTabs). */}
                {tabsShown ? (
                    <BottomTabs
                        label={t("phoneTabs.label")}
                        tabs={[
                            {
                                id: "chats",
                                label: t("phoneTabs.chats"),
                                icon: <MessageSquare />,
                                active: tab === "chats",
                                badge: badges.chats,
                                onSelect: () => chooseTab("chats")
                            },
                            {
                                id: "servers",
                                label: t("phoneTabs.servers"),
                                icon: <Server />,
                                active: tab === "servers",
                                badge: badges.servers,
                                onSelect: () => chooseTab("servers")
                            },
                            {
                                id: "calls",
                                label: t("phoneTabs.calls"),
                                icon: <Video />,
                                active: tab === "calls",
                                onSelect: () => chooseTab("calls")
                            }
                        ]}
                    />
                ) : null}
            </div>
        </ChatLockProvider>
    );
}
