"use client";

/**
 * What a right-click on a message offers.
 *
 * The same actions the hover row carries, and deliberately so: a menu that can
 * do things the visible controls cannot is a menu people have to find out
 * about. This is the faster way to reach them, not a second set.
 *
 * It wraps the row rather than living inside it, so the whole message is the
 * target - right-clicking the text, the avatar or the empty space to the right
 * all open the same menu, which is what everybody expects from a chat client.
 */

import type { ReactNode } from "react";
import { isPlayable } from "./voice-recorder";
import { useAppUrl } from "@/components/app-url";
import { plainText } from "@/components/rich-text/excerpt";
import type { ChatMessageView } from "@/lib/chat/messages";
import { copyText, downloadFile, messageLink } from "./links";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    keepFocusOnClose
} from "@polaris/ui";
import {
    Copy,
    Download,
    Flag,
    CornerUpLeft,
    Forward,
    Info,
    Link2,
    MessageSquare,
    Pencil,
    Star,
    Trash2
} from "lucide-react";

export interface MessageActions {
    readonly message: ChatMessageView;
    readonly mine: boolean;
    readonly canPost: boolean;
    readonly canModerate: boolean;
    /** The three a thread does not have: answering, forwarding and rewriting all
     *  happen in the channel, and an item that does nothing is worse than one
     *  that is not there. */
    readonly onReply?: (message: ChatMessageView) => void;
    readonly onForward?: (message: ChatMessageView) => void;
    readonly onEdit?: (message: ChatMessageView) => void;
    readonly onOpenThread?: (message: ChatMessageView) => void;
    readonly onStar: (message: ChatMessageView) => void;
    readonly onDelete: (message: ChatMessageView) => void;
    /** Say something is wrong with it. Not offered on your own message: the
     *  thing to do about your own words is take them back, which is Delete. */
    readonly onReport: (message: ChatMessageView) => void;
    /** When it was sent, when it arrived, when it was read. */
    readonly onExplain: (message: ChatMessageView) => void;
}

export function MessageMenu({
    actions,
    children
}: {
    actions: MessageActions;
    children: ReactNode;
}) {
    const { message, mine, canPost, canModerate } = actions;
    const baseUrl = useAppUrl();
    // A recording is the one attachment with no way to save it from the message
    // itself: a picture opens into a viewer that offers it and a document is a
    // link, but a player is a player. So the menu is where it lives.
    const recordings = message.attachments.filter((file) => isPlayable(file.contentType));

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            {/* Focus is not handed back to the message row on the way out: Reply
                and Edit put the caret in the composer, and the hand-back landed
                a beat later and took it straight out again. */}
            <ContextMenuContent className="w-52" onCloseAutoFocus={keepFocusOnClose}>
                {canPost && !message.deleted && (
                    <>
                        {actions.onReply && (
                            <ContextMenuItem onSelect={() => actions.onReply?.(message)}>
                                <CornerUpLeft className="size-3.5" />
                                Reply
                                <span className="ml-auto pl-6 text-[11px] text-foreground-subtle">
                                    R
                                </span>
                            </ContextMenuItem>
                        )}
                        {/* Absent rather than refused when whoever wrote it does
                            not allow it. A menu that offers something and then
                            says no is worse than one that offers less. */}
                        {message.forwardable && actions.onForward && (
                            <ContextMenuItem onSelect={() => actions.onForward?.(message)}>
                                <Forward className="size-3.5" />
                                Forward
                            </ContextMenuItem>
                        )}
                        {actions.onOpenThread && (
                            <ContextMenuItem onSelect={() => actions.onOpenThread?.(message)}>
                                <MessageSquare className="size-3.5" />
                                Reply in a thread
                            </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                    </>
                )}

                <ContextMenuItem onSelect={() => actions.onStar(message)}>
                    <Star className="size-3.5" />
                    {message.starred ? "Remove from saved" : "Save"}
                </ContextMenuItem>
                {/* Offered on a deleted message too: the line is still there,
                    replies still hang off it, and its address still opens the
                    conversation at the right place. */}
                <ContextMenuItem
                    onSelect={() =>
                        void copyText(messageLink(baseUrl, message.channelId, message.id))
                    }
                >
                    <Link2 className="size-3.5" />
                    Copy link
                </ContextMenuItem>
                {/* What it reads as, not what it is stored as. Markdown escapes
                    its punctuation, so copying the source hands back a line full
                    of backslashes for one that reads perfectly well on screen. */}
                {!message.deleted && (
                    <ContextMenuItem onSelect={() => void copyText(plainText(message.body))}>
                        <Copy className="size-3.5" />
                        Copy text
                    </ContextMenuItem>
                )}
                {!message.deleted &&
                    recordings.map((file) => (
                        <ContextMenuItem
                            key={file.id}
                            onSelect={() =>
                                downloadFile(`/api/chat/attachments/${file.id}`, file.name)
                            }
                        >
                            <Download className="size-3.5" />
                            {/* Named only when there is more than one, since a
                                voice message has no name worth reading. */}
                            <span className="min-w-0 truncate">
                                {recordings.length === 1 ? "Download the audio" : file.name}
                            </span>
                        </ContextMenuItem>
                    ))}

                {/* Only where there are ticks to explain, which is exactly a
                    one-to-one conversation, your own message, and both people
                    allowing them - the same rule that decides whether the ticks
                    are drawn, asked once on the server and carried here. */}
                {message.receipt && !message.deleted && (
                    <ContextMenuItem onSelect={() => actions.onExplain(message)}>
                        <Info className="size-3.5" />
                        Information
                    </ContextMenuItem>
                )}

                {!mine && !message.deleted && (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => actions.onReport(message)}>
                            <Flag className="size-3.5" />
                            Report
                        </ContextMenuItem>
                    </>
                )}

                {canPost && !message.deleted && (mine || canModerate) && (
                    <>
                        <ContextMenuSeparator />
                        {/* The keys said out loud, because a shortcut nobody is
                            told about is a shortcut nobody uses. Both act on the
                            message under the pointer, which is this one. */}
                        {mine && actions.onEdit && (
                            <ContextMenuItem onSelect={() => actions.onEdit?.(message)}>
                                <Pencil className="size-3.5" />
                                Edit
                                <span className="ml-auto pl-6 text-[11px] text-foreground-subtle">
                                    F2
                                </span>
                            </ContextMenuItem>
                        )}
                        <ContextMenuItem
                            variant="danger"
                            onSelect={() => actions.onDelete(message)}
                        >
                            <Trash2 className="size-3.5" />
                            Delete
                            <span className="ml-auto pl-6 text-[11px] text-foreground-subtle">
                                Del
                            </span>
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}
