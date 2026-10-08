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
 *
 * Like WhatsApp's starred list it can be narrowed to one conversation - the
 * conversation's own menu opens it that way, `?c=<channelId>` - and pressing a
 * message opens the conversation at that message rather than at its end. "Unstar
 * all" clears the list (or that conversation's part of it) after asking.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useChat } from "../chat-context";
import { Avatar } from "@/components/avatar";
import { Button, ConfirmDeleteDialog, EmptyState, Select, Skeleton } from "@polaris/ui";
import { PersonName } from "@/components/person-name";
import { starAction, starredAction, unstarAllAction } from "../actions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageTime } from "@/components/message-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import { RichText } from "@/components/rich-text/rich-text";
import { ArrowLeft, Hash, Star, Users } from "lucide-react";

/** The filter's value for "every conversation". Radix refuses an empty item. */
const EVERYWHERE = "all";

export function SavedView() {
    const t = useTranslations("chat");
    const router = useRouter();
    const params = useSearchParams();
    const { channels } = useChat();
    const only = params.get("c");
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(null);
    const [clearing, setClearing] = useState(false);
    const [busy, setBusy] = useState(false);
    const onlyChannel = only ? channels.find((entry) => entry.id === only) : undefined;

    const load = useCallback(() => {
        setMessages(null);
        void starredAction(only ?? undefined).then((result) => setMessages(result.messages));
    }, [only]);

    useEffect(load, [load]);

    /** The conversations the list can be narrowed to: every one this reader
     *  has, by name. The one in the address is kept even before the rail has
     *  loaded, so the filter never reads blank. */
    const choices = useMemo(
        () => [
            { value: EVERYWHERE, label: t("saved.allConversations") },
            ...channels
                .filter((entry) => entry.id !== only)
                .map((entry) => ({ value: entry.id, label: entry.name })),
            ...(only ? [{ value: only, label: onlyChannel?.name ?? "" }] : [])
        ],
        [channels, only, onlyChannel?.name, t]
    );

    const clearAll = async () => {
        setBusy(true);
        const before = messages;
        setMessages([]);
        try {
            await unstarAllAction(only ?? undefined);
            setClearing(false);
        } catch {
            setMessages(before);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Link
                    href="/chat"
                    aria-label={t("saved.backToConversations")}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <Star className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 truncate text-sm font-semibold">{t("saved.saved")}</span>
                <span className="ml-auto flex min-w-0 items-center gap-2">
                    <Select
                        value={only ?? EVERYWHERE}
                        onValueChange={(value) =>
                            router.replace(
                                value === EVERYWHERE ? "/chat/saved" : `/chat/saved?c=${value}`
                            )
                        }
                        aria-label={t("saved.allConversations")}
                        options={choices}
                        className="h-8 w-40 min-w-0 max-w-[45vw]"
                    />
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={!messages || messages.length === 0}
                        onClick={() => setClearing(true)}
                    >
                        {t("saved.unstarAll")}
                    </Button>
                </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                {messages === null ? (
                    <div className="flex flex-col gap-2" aria-hidden="true">
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-16 w-full" />
                        ))}
                    </div>
                ) : messages.length === 0 ? (
                    <EmptyState
                        icon={<Star />}
                        title={t("saved.nothingSaved")}
                        description={t("saved.hoverAMessageAndPress")}
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
                                            <PersonName
                                                id={message.authorId}
                                                name={message.authorName ?? "Somebody who has left"}
                                            />
                                        </span>
                                        <MessageTime
                                            iso={message.createdAt}
                                            className="shrink-0 whitespace-nowrap"
                                        />
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
                                                aria-label={t("saved.removeFromSaved")}
                                                title={t("saved.removeFromSaved")}
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
                                    {/* The message itself opens the conversation at
                                        it, which is what a star is kept for. */}
                                    <Link
                                        href={`/chat/c/${message.channelId}/${message.id}`}
                                        title={t("saved.openInConversation")}
                                        className="mt-1 block rounded text-sm transition-colors hover:bg-card-hover"
                                    >
                                        <RichText value={message.body} />
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <ConfirmDeleteDialog
                open={clearing}
                onOpenChange={setClearing}
                requireTyping={false}
                name=""
                kind=""
                title={t("saved.unstarAll")}
                question={
                    only
                        ? t("saved.unstarAllHere", { name: onlyChannel?.name ?? "" })
                        : t("saved.unstarAllTitle")
                }
                description={t("saved.unstarAllBody")}
                confirmLabel={t("saved.unstarAll")}
                pending={busy}
                onConfirm={() => void clearAll()}
                strings={{ cancel: t("saved.cancel") }}
            />
        </div>
    );
}
