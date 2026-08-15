"use client";

/**
 * A message arriving while you are somewhere else.
 *
 * Mounted by the dashboard shell rather than by Chat, for the same reason the
 * incoming-call card is: somebody reading a task board or a log has no way of
 * knowing anybody said anything, and "open Chat and look" is not a notification.
 *
 * It goes nowhere near the notification bell. That is a record - a list somebody
 * clears and expects to persist - and a chat message is not one. Fifty messages
 * in an afternoon would bury the four notifications that mattered, which is
 * exactly what people mean when they turn notifications off.
 *
 * What arrives on the wire is a channel id and nothing else, by design, so the
 * words are fetched afterwards through the same access check that draws the
 * conversation. Muted conversations never come back from it.
 *
 * One note per conversation, replaced rather than stacked: ten messages in one
 * room is one note that keeps changing, which is what every messenger does and
 * what stops a busy channel from filling the screen.
 */

import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { usePathname } from "next/navigation";
import { useToast, type Toast } from "@polaris/ui";
import { useCallback, useEffect, useRef } from "react";
import { messageToastsAction } from "@/app/(app)/chat/actions";
import { useChatStream } from "@/app/(app)/chat/use-chat-stream";
import { notifyDesktop, tabIsWatched } from "@/lib/desktop-notify";

/** How long the words wait for more of them before being fetched. A burst of
 *  five messages is one request, not five. */
const SETTLE_MS = 400;

export function MessageToasts() {
    const router = useRouter();
    const pathname = usePathname();
    const toast = useToast();

    // Held in refs because the stream subscription is set up once: a callback
    // rebuilt on every navigation would tear the subscription down with it.
    const here = useRef(pathname);
    here.current = pathname;
    const raise = useRef(toast.show);
    raise.current = toast.show;
    const go = useRef(router.push);
    go.current = router.push;

    const pending = useRef(new Set<string>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const owner = useRef(false);

    const flush = useCallback(async () => {
        const asked = [...pending.current];
        pending.current.clear();
        if (asked.length === 0) return;

        const { toasts } = await messageToastsAction(asked).catch(() => ({ toasts: [] }));
        for (const message of toasts) {
            // The conversation somebody is standing in needs no announcement:
            // the message is already on their screen.
            if (here.current.startsWith(`/chat/c/${message.channelId}`)) continue;

            const who = message.inChannel
                ? `${message.authorName} in ${message.conversation}`
                : message.authorName;
            const note: Toast = {
                key: `message:${message.channelId}`,
                title: who,
                body: message.excerpt,
                icon: (
                    <Avatar
                        size={28}
                        person={{ id: message.authorId ?? message.channelId, name: message.authorName }}
                    />
                ),
                onPress: () => go.current(`/chat/c/${message.channelId}/${message.messageId}`)
            };
            raise.current(note);

            // Past the window as well, when nobody is looking at it - and only
            // from the tab holding the connection, so one device draws one.
            if (owner.current && !tabIsWatched()) {
                void notifyDesktop({
                    title: who,
                    body: message.excerpt,
                    tag: `message:${message.channelId}`,
                    href: `/chat/c/${message.channelId}/${message.messageId}`
                });
            }
        }
    }, []);

    useChatStream(
        useCallback(
            (frame, context) => {
                if (frame.kind !== "posted") return;
                // A tab that is neither being looked at nor holding the
                // connection has nobody to tell and nothing to draw.
                if (!context.owner && !tabIsWatched()) return;

                owner.current = context.owner;
                for (const channelId of frame.channels) {
                    if (here.current.startsWith(`/chat/c/${channelId}`)) continue;
                    pending.current.add(channelId);
                }
                if (pending.current.size === 0) return;

                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => void flush(), SETTLE_MS);
            },
            [flush]
        )
    );

    useEffect(() => {
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, []);

    return null;
}
