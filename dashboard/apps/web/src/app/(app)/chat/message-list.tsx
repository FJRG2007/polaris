"use client";

/**
 * The messages themselves.
 *
 * Grouped the way every chat client groups them: three messages from the same
 * person a minute apart are one block with one name and one face, not three
 * headers. That is not decoration - the repeated header is what makes a busy
 * channel unreadable, because the eye has to skip past the same name to reach
 * each new line.
 *
 * A day separator sits between days. Timestamps are relative ("4 minutes ago"),
 * which is what somebody reading a conversation wants; the exact time is on the
 * hover, which is what somebody quoting one wants.
 *
 * Deleted messages leave a line saying so rather than vanishing. A conversation
 * where replies suddenly answer nothing is worse than one that admits something
 * was taken back.
 */

import { Avatar } from "@/components/avatar";
import { RelativeTime } from "@/components/relative-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import { RichText } from "@/components/rich-text/rich-text";
import { useDisplayFormat } from "@/components/display-format";
import { MessageSquare, Pencil, SmilePlus, Trash2 } from "lucide-react";
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@polaris/ui";

/** How close together two messages have to be to share a header. Long enough
 *  that a paused sentence stays one block, short enough that coming back an hour
 *  later starts a new one. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** The emoji the hover offers without opening anything. Six, because a row of
 *  six is read at a glance and a row of thirty is a menu with no lid. */
const QUICK_EMOJI = ["👍", "❤️", "😄", "🎉", "👀", "✅"] as const;

export interface MessageListProps {
    messages: readonly ChatMessageView[];
    viewerId: string;
    /** False in an archived conversation: everything is still readable, nothing
     *  is actionable. */
    canPost: boolean;
    /** True for somebody who moderates the channel, who may delete anybody's. */
    canModerate: boolean;
    /** Absent inside a thread, where a reply has nowhere further to go. */
    onOpenThread?: (message: ChatMessageView) => void;
    onReact: (messageId: string, emoji: string) => void;
    onEdit: (message: ChatMessageView) => void;
    onDelete: (message: ChatMessageView) => void;
}

export function MessageList({
    messages,
    viewerId,
    canPost,
    canModerate,
    onOpenThread,
    onReact,
    onEdit,
    onDelete
}: MessageListProps) {
    return (
        <ol className="flex flex-col">
            {messages.map((message, index) => {
                const previous = index > 0 ? messages[index - 1] : undefined;
                const newDay = !previous || !sameDay(previous.createdAt, message.createdAt);
                const grouped =
                    !newDay &&
                    previous !== undefined &&
                    previous.authorId === message.authorId &&
                    message.authorId !== null &&
                    !previous.deleted &&
                    !message.deleted &&
                    withinWindow(previous.createdAt, message.createdAt);

                return (
                    <li key={message.id}>
                        {newDay && <DaySeparator iso={message.createdAt} />}
                        <Message
                            message={message}
                            grouped={grouped}
                            mine={message.authorId === viewerId}
                            canPost={canPost}
                            canModerate={canModerate}
                            onOpenThread={onOpenThread}
                            onReact={onReact}
                            onEdit={onEdit}
                            onDelete={onDelete}
                        />
                    </li>
                );
            })}
        </ol>
    );
}

function Message({
    message,
    grouped,
    mine,
    canPost,
    canModerate,
    onOpenThread,
    onReact,
    onEdit,
    onDelete
}: {
    message: ChatMessageView;
    grouped: boolean;
    mine: boolean;
    canPost: boolean;
    canModerate: boolean;
    onOpenThread?: (message: ChatMessageView) => void;
    onReact: (messageId: string, emoji: string) => void;
    onEdit: (message: ChatMessageView) => void;
    onDelete: (message: ChatMessageView) => void;
}) {
    const format = useDisplayFormat();
    const author = message.authorName ?? "Somebody who has left";

    if (message.kind === "system") {
        return (
            <p className="px-4 py-1 text-xs text-muted-foreground">
                {message.body}{" "}
                <RelativeTime iso={message.createdAt} />
            </p>
        );
    }

    return (
        <div
            className={cn(
                "group relative flex gap-2 px-4 transition-colors hover:bg-card-hover/60",
                grouped ? "py-0.5" : "pb-0.5 pt-3"
            )}
        >
            <span className="w-8 shrink-0">
                {grouped ? (
                    <span
                        className="hidden pt-1 text-[10px] leading-4 text-foreground-subtle group-hover:block"
                        title={format.dateTime(message.createdAt)}
                    >
                        {format.time(message.createdAt)}
                    </span>
                ) : message.authorId ? (
                    <Avatar person={{ id: message.authorId, name: author }} size={28} />
                ) : (
                    <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                        ?
                    </span>
                )}
            </span>

            <div className="min-w-0 flex-1 pb-0.5">
                {!grouped && (
                    <p className="flex items-baseline gap-2">
                        <span className="text-sm font-medium">{author}</span>
                        <span
                            className="text-[11px] text-foreground-subtle"
                            title={format.dateTime(message.createdAt)}
                        >
                            <RelativeTime iso={message.createdAt} />
                        </span>
                    </p>
                )}

                {message.deleted ? (
                    <p className="text-sm italic text-foreground-subtle">
                        This message was deleted.
                    </p>
                ) : (
                    <div className="text-sm">
                        <RichText value={message.body} />
                        {message.edited && (
                            <span className="ml-1 text-[11px] text-foreground-subtle">(edited)</span>
                        )}
                    </div>
                )}

                {message.reactions.length > 0 && (
                    <ul className="mt-1 flex flex-wrap gap-1">
                        {message.reactions.map((reaction) => (
                            <li key={reaction.emoji}>
                                <button
                                    type="button"
                                    disabled={!canPost}
                                    onClick={() => onReact(message.id, reaction.emoji)}
                                    aria-pressed={reaction.mine}
                                    className={cn(
                                        "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors disabled:opacity-60",
                                        reaction.mine
                                            ? "border-primary/60 bg-primary/15 text-foreground"
                                            : "border-border bg-muted text-muted-foreground hover:border-border-strong"
                                    )}
                                >
                                    <span>{reaction.emoji}</span>
                                    <span>{reaction.count}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                {message.replyCount > 0 && onOpenThread && (
                    <button
                        type="button"
                        onClick={() => onOpenThread(message)}
                        className="mt-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-muted"
                    >
                        <MessageSquare className="size-3" />
                        {message.replyCount === 1 ? "1 reply" : `${message.replyCount} replies`}
                        {message.lastReplyAt && (
                            <span className="font-normal text-muted-foreground">
                                <RelativeTime iso={message.lastReplyAt} />
                            </span>
                        )}
                    </button>
                )}
            </div>

            {canPost && !message.deleted && (
                <div className="absolute right-3 top-0 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-elevated p-0.5 shadow-popover group-focus-within:flex group-hover:flex">
                    {QUICK_EMOJI.map((emoji) => (
                        <button
                            key={emoji}
                            type="button"
                            aria-label={`React with ${emoji}`}
                            onClick={() => onReact(message.id, emoji)}
                            className="rounded px-1 py-0.5 text-sm transition-colors hover:bg-muted"
                        >
                            {emoji}
                        </button>
                    ))}
                    {onOpenThread && (
                        <button
                            type="button"
                            aria-label="Reply in a thread"
                            title="Reply in a thread"
                            onClick={() => onOpenThread(message)}
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <MessageSquare className="size-3.5" />
                        </button>
                    )}
                    {(mine || canModerate) && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    aria-label="More for this message"
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    <SmilePlus className="size-3.5 rotate-90" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                {mine && (
                                    <DropdownMenuItem onSelect={() => onEdit(message)}>
                                        <Pencil className="size-3.5" />
                                        Edit
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onSelect={() => onDelete(message)}>
                                    <Trash2 className="size-3.5" />
                                    Delete
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
            )}
        </div>
    );
}

function DaySeparator({ iso }: { iso: string }) {
    const format = useDisplayFormat();
    return (
        <div className="flex items-center gap-3 px-4 pt-4">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[11px] font-medium text-foreground-subtle">{format.date(iso)}</span>
            <span className="h-px flex-1 bg-border" />
        </div>
    );
}

function sameDay(left: string, right: string): boolean {
    return new Date(left).toDateString() === new Date(right).toDateString();
}

function withinWindow(left: string, right: string): boolean {
    return new Date(right).getTime() - new Date(left).getTime() < GROUP_WINDOW_MS;
}
