"use client";

/**
 * Everything kept, newest first.
 *
 * Each one says which conversation it came from and links back to it, because
 * that is what somebody is here for: a message they saved is a thing to return
 * to, and a list of quotes with no way back to the room is a list of loose
 * sentences.
 *
 * Not grouped and not searchable. Both would be right for a list of two hundred
 * and this one is a handful by construction - people star what they mean to come
 * back to, and what they come back to they unstar.
 */

import Link from "next/link";
import { useChat } from "../chat-context";
import { Avatar } from "@/components/avatar";
import { EmptyState, Skeleton } from "@polaris/ui";
import { starAction, starredAction } from "../actions";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import { RichText } from "@/components/rich-text/rich-text";
import { ArrowLeft, Hash, Star, Users } from "lucide-react";

export function SavedView() {
    const { channels } = useChat();
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(null);

    const load = useCallback(() => {
        void starredAction().then((result) => setMessages(result.messages));
    }, []);

    useEffect(load, [load]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Link
                    href="/chat"
                    aria-label="Back to conversations"
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <Star className="size-4 shrink-0 text-primary" />
                <span className="text-sm font-semibold">Saved</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {messages === null ? (
                    <div className="flex flex-col gap-2" aria-hidden="true">
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-16 w-full" />
                        ))}
                    </div>
                ) : messages.length === 0 ? (
                    <EmptyState
                        icon={<Star />}
                        title="Nothing saved."
                        description="Hover a message and press the star to keep it. Only you see this."
                    />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {messages.map((message) => {
                            const channel = channels.find(
                                (entry) => entry.id === message.channelId
                            );
                            return (
                                <li
                                    key={message.id}
                                    className="rounded-lg border border-border bg-card p-3"
                                >
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        {message.authorId && (
                                            <Avatar
                                                person={{
                                                    id: message.authorId,
                                                    name: message.authorName ?? "Someone"
                                                }}
                                                size={18}
                                            />
                                        )}
                                        <span className="font-medium text-foreground">
                                            {message.authorName ?? "Somebody who has left"}
                                        </span>
                                        <RelativeTime iso={message.createdAt} />
                                        <span className="ml-auto flex items-center gap-1">
                                            {channel && (
                                                <Link
                                                    href={`/chat/c/${message.channelId}`}
                                                    className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                                                >
                                                    {channel.spaceId ? (
                                                        <Hash className="size-3" />
                                                    ) : (
                                                        <Users className="size-3" />
                                                    )}
                                                    <span
                                                        title={channel.name}
                                                        className="max-w-[12rem] truncate"
                                                    >
                                                        {channel.name}
                                                    </span>
                                                </Link>
                                            )}
                                            <button
                                                type="button"
                                                aria-label="Remove from saved"
                                                title="Remove from saved"
                                                onClick={async () => {
                                                    // Taken off the list here
                                                    // rather than by asking for
                                                    // the whole list again: a
                                                    // reload replaces every row
                                                    // and throws the page back
                                                    // to the top.
                                                    setMessages(
                                                        (current) =>
                                                            current?.filter(
                                                                (entry) => entry.id !== message.id
                                                            ) ?? current
                                                    );
                                                    await starAction(message.id);
                                                }}
                                                className="rounded p-1 text-primary transition-colors hover:bg-muted"
                                            >
                                                <Star className="size-3.5 fill-current" />
                                            </button>
                                        </span>
                                    </div>
                                    <div className="mt-1 text-sm">
                                        <RichText value={message.body} />
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
