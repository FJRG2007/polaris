"use client";

/**
 * A look inside a conversation without opening it: what a long press on a row
 * shows above its menu, the way iOS and WhatsApp peek at a chat.
 *
 * Read-only, and reading it marks nothing read - the newest page is asked for
 * the way the conversation asks for it, and only opening the conversation tells
 * anybody it was seen. The last answer per conversation is kept for the length
 * of the visit, so a second peek draws at once and is brought up to date behind.
 */

import * as actions from "./actions";
import { useChat } from "./chat-context";
import { Skeleton, cn } from "@polaris/ui";
import { unlockProofFor } from "./lock-session";
import { useEffect, useMemo, useState } from "react";
import { PEEK_LIMIT, peekLines } from "./phone-chat";
import { useOpenedSealed } from "./opened-sealed";
import { RelativeTime } from "@/components/relative-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { useTranslations } from "@/components/i18n/i18n-provider";

const NONE: readonly ChatMessageView[] = [];

/** The newest messages per conversation peeked at, capped so a long visit does
 *  not keep every conversation it ever looked into. */
const kept = new Map<string, readonly ChatMessageView[]>();
const KEPT_MAX = 20;

function keep(channelId: string, messages: readonly ChatMessageView[]): void {
    kept.delete(channelId);
    kept.set(channelId, messages.slice(-PEEK_LIMIT * 3));
    if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
}

export function ConversationPeek({ channel }: { channel: ChatChannelView }) {
    const t = useTranslations("chat");
    const { viewerId } = useChat();
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(
        () => kept.get(channel.id) ?? null
    );
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        // Behind the reader's chat lock the peek says so instead of asking: the
        // code is asked for where the conversation opens, not in a menu.
        if (channel.locked) return;
        let live = true;
        void actions.readChannelAction(channel.id, undefined, unlockProofFor(channel.id)).then(
            (result) => {
                if (!live) return;
                if (!result.page) {
                    setFailed(true);
                    return;
                }
                keep(channel.id, result.page.messages);
                setMessages(result.page.messages);
            },
            () => {
                if (live) setFailed(true);
            }
        );
        return () => {
            live = false;
        };
    }, [channel.id, channel.locked]);
    const opened = useOpenedSealed(messages ?? NONE);

    const lines = useMemo(
        () => (messages ? peekLines(opened, viewerId, t) : null),
        [messages, opened, viewerId, t]
    );
    // Who said it matters only where more than one other person could have.
    const named = channel.spaceId !== null || channel.others.length > 1;

    return (
        <div className="flex flex-col gap-2 px-2 pt-1 pb-2" aria-label={t("peek.label")}>
            <p className="min-w-0 truncate text-sm font-semibold" title={channel.name}>
                {channel.name}
            </p>
            {channel.locked ? (
                <p className="text-xs text-foreground-subtle">{t("peek.locked")}</p>
            ) : lines === null ? (
                failed ? (
                    <p role="alert" className="text-xs text-danger">
                        {t("peek.failed")}
                    </p>
                ) : (
                    <div className="flex flex-col gap-1.5" aria-hidden>
                        <Skeleton className="h-7 w-3/5" />
                        <Skeleton className="h-7 w-2/5 self-end" />
                        <Skeleton className="h-7 w-1/2" />
                    </div>
                )
            ) : lines.length === 0 ? (
                <p className="text-xs text-foreground-subtle">{t("peek.empty")}</p>
            ) : (
                <ol className="flex max-h-[40dvh] flex-col gap-1.5 overflow-y-auto overscroll-contain">
                    {lines.map((line) => (
                        <li
                            key={line.id}
                            className={cn(
                                "flex min-w-0 max-w-[85%] flex-col rounded-lg px-2.5 py-1.5 text-sm",
                                line.mine ? "self-end bg-primary/15" : "self-start bg-muted"
                            )}
                        >
                            {named && !line.mine && line.author ? (
                                <span
                                    className="min-w-0 truncate text-[0.6875rem] font-medium text-muted-foreground"
                                    title={line.author}
                                >
                                    {line.author}
                                </span>
                            ) : null}
                            <span className="line-clamp-3 break-words">{line.text}</span>
                            <RelativeTime
                                iso={line.at}
                                formatStyle="narrow"
                                className="self-end text-[0.625rem] text-foreground-subtle"
                            />
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}
