/**
 * Chat on a phone, the parts that are decisions rather than drawing.
 *
 * A phone shows one of three places at the bottom - the conversations, the
 * servers, the calls - the way WhatsApp and Telegram split theirs. Which one is
 * open is read off what is already on screen rather than kept beside it: the
 * address says whether it is the calls, and the space the rail stands in says
 * whether it is a server. A second copy of that state would be one that drifts.
 */

import { plainExcerpt } from "@/components/rich-text/excerpt";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatChannelView } from "@/lib/chat/chat-service";

export type PhoneChatTab = "chats" | "servers" | "calls";

/** The meetings list is the Calls tab; a meeting's own room is a conversation. */
export function phoneChatTab(
    pathname: string,
    activeSpaceId: string | null,
    /** Servers was picked with no space to stand in - somebody in none yet. */
    serversPicked: boolean
): PhoneChatTab {
    if (pathname === "/chat/meetings") return "calls";
    if (activeSpaceId !== null || serversPicked) return "servers";
    return "chats";
}

/** Waiting, per tab: what a muted conversation counts is not shouted about. */
export function phoneTabBadges(channels: readonly ChatChannelView[]): {
    chats: number;
    servers: number;
} {
    let chats = 0;
    let servers = 0;
    for (const channel of channels) {
        if (channel.muted || channel.unread === 0) continue;
        if (channel.spaceId === null) chats += channel.unread;
        else servers += channel.unread;
    }
    return { chats, servers };
}

/** What a list row or a peek says a message was. Empty for a system line. */
export function previewText(
    last: { readonly deleted: boolean; readonly kind: string; readonly body: string },
    t: (key: "listView.deleted" | "listView.call" | "listView.poll" | "listView.location" | "listView.attachment") => string
): string {
    if (last.deleted) return t("listView.deleted");
    if (last.kind === "call") return t("listView.call");
    if (last.kind === "poll") return t("listView.poll");
    if (last.kind === "location") return last.body.replace(/\s+/g, " ").trim() || t("listView.location");
    if (last.kind === "system") return "";
    return last.body.replace(/\s+/g, " ").trim() || t("listView.attachment");
}

export interface PeekLine {
    readonly id: string;
    readonly mine: boolean;
    readonly author: string;
    readonly text: string;
    readonly at: string;
}

/** How many of the newest messages a peek shows. */
export const PEEK_LIMIT = 8;

/**
 * The newest messages of a conversation, as a peek draws them: oldest first,
 * replies and system lines left out - a peek is the conversation as its list
 * reads, not every line in it.
 */
export function peekLines(
    messages: readonly ChatMessageView[],
    viewerId: string,
    t: Parameters<typeof previewText>[1],
    limit: number = PEEK_LIMIT
): PeekLine[] {
    const lines: PeekLine[] = [];
    for (let index = messages.length - 1; index >= 0 && lines.length < limit; index--) {
        const message = messages[index]!;
        if (message.parentId) continue;
        // A message holds its Markdown; the list's last line is already plain.
        const text = previewText({ ...message, body: plainExcerpt(message.body, 240) }, t);
        if (!text) continue;
        lines.push({
            id: message.id,
            mine: message.authorId === viewerId,
            author: message.authorName ?? "",
            text,
            at: message.createdAt
        });
    }
    return lines.reverse();
}
