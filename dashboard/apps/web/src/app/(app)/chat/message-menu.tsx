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
import { copyText, messageLink } from "./links";
import { useAppUrl } from "@/components/app-url";
import type { ChatMessageView } from "@/lib/chat/messages";
import {
    Copy,
    CornerUpLeft,
    Forward,
    Link2,
    MessageSquare,
    Pencil,
    Star,
    Trash2
} from "lucide-react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger
} from "@polaris/ui";

export interface MessageActions {
    readonly message: ChatMessageView;
    readonly mine: boolean;
    readonly canPost: boolean;
    readonly canModerate: boolean;
    readonly onReply: (message: ChatMessageView) => void;
    readonly onForward: (message: ChatMessageView) => void;
    readonly onOpenThread?: (message: ChatMessageView) => void;
    readonly onStar: (message: ChatMessageView) => void;
    readonly onEdit: (message: ChatMessageView) => void;
    readonly onDelete: (message: ChatMessageView) => void;
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

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-48">
                {canPost && !message.deleted && (
                    <>
                        <ContextMenuItem onSelect={() => actions.onReply(message)}>
                            <CornerUpLeft className="size-3.5" />
                            Reply
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => actions.onForward(message)}>
                            <Forward className="size-3.5" />
                            Forward
                        </ContextMenuItem>
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
                {!message.deleted && (
                    <ContextMenuItem onSelect={() => void copyText(message.body)}>
                        <Copy className="size-3.5" />
                        Copy text
                    </ContextMenuItem>
                )}

                {canPost && !message.deleted && (mine || canModerate) && (
                    <>
                        <ContextMenuSeparator />
                        {mine && (
                            <ContextMenuItem onSelect={() => actions.onEdit(message)}>
                                <Pencil className="size-3.5" />
                                Edit
                            </ContextMenuItem>
                        )}
                        <ContextMenuItem
                            variant="danger"
                            onSelect={() => actions.onDelete(message)}
                        >
                            <Trash2 className="size-3.5" />
                            Delete
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}
