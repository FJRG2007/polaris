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
 * words - and the picture of what was sent, when there is one - are fetched
 * afterwards through the same access check that draws the conversation. Muted
 * conversations never come back from it.
 *
 * One note per conversation, replaced rather than stacked: ten messages in one
 * room is one note that keeps changing, which is what every messenger does and
 * what stops a busy channel from filling the screen.
 *
 * The conversation open in this tab is only exempt while somebody is attending to
 * the tab. Left open behind another window, it is announced like any other - see
 * `lib/chat/message-alert` for the whole decision.
 */

import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { usePathname } from "next/navigation";
import { playCallSound } from "@/lib/call-sounds";
import { useToast, type Toast } from "@polaris/ui";
import { claimForDevice } from "@/lib/device-once";
import { useCallback, useEffect, useRef } from "react";
import { ToastPicture } from "@/components/toast-picture";
import { useSessionScope } from "@/components/session-scope";
import { messageToastsAction } from "@/app/(app)/chat/actions";
import { useChatStream } from "@/app/(app)/chat/use-chat-stream";
import { closeDesktopNotice, notifyDesktop, tabIsWatched } from "@/lib/desktop-notify";
import { notificationSoundEnabled } from "@/lib/notification-sound";
import {
    arrivalAlert,
    markSeenOnDevice,
    seenOnDevice,
    showsConversation
} from "@/lib/chat/message-alert";

/** How long the words wait for more of them before being fetched. A burst of
 *  five messages is one request, not five. */
const SETTLE_MS = 400;

export function MessageToasts() {
    const router = useRouter();
    const pathname = usePathname();
    const toast = useToast();
    const scope = useSessionScope();

    // Held in refs because the stream subscription is set up once: a callback
    // rebuilt on every navigation would tear the subscription down with it.
    const here = useRef(pathname);
    here.current = pathname;
    const raise = useRef(toast.show);
    raise.current = toast.show;
    const drop = useRef(toast.dismiss);
    drop.current = toast.dismiss;
    const go = useRef(router.push);
    go.current = router.push;

    /** Conversations waiting to be announced, and when this tab heard of each. */
    const pending = useRef(new Map<string, number>());
    /**
     * Conversations caught up while this tab was asking for the words.
     *
     * The queue is copied and cleared before that round trip, so a read landing
     * during it has nothing left to take out - and the announcement would arrive
     * for a conversation the reader is looking straight at. An entry is dropped
     * again when the next message lands in that conversation.
     */
    const caughtUp = useRef(new Set<string>());
    /**
     * The last message announced in each conversation.
     *
     * A conversation followed for mentions answers with the newest message that
     * names this reader, which is usually not the newest message in it - so
     * every ordinary message that lands in the minute after one fetches the same
     * mention back. Without this, that channel raises the note and plays the
     * chime again for each of them, which is the interruption the level exists
     * to prevent. One entry per conversation, so it is bounded by the rail.
     */
    const announced = useRef(new Map<string, string>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // The session scope, which is this account's id: it keys the claims that
    // settle which tab of a device acts, and tells this reader's read frame
    // apart from the other side of a conversation catching up.
    const device = useRef(scope);
    device.current = scope;

    const flush = useCallback(async () => {
        const heard = new Map(pending.current);
        const asked = [...heard.keys()];
        pending.current.clear();
        if (asked.length === 0) return;

        const { toasts } = await messageToastsAction(asked).catch(() => ({ toasts: [] }));
        let sounded = false;
        for (const message of toasts) {
            const inThatChat = showsConversation(here.current, message.channelId);
            const alert = arrivalAlert({
                inThatChat,
                attended: tabIsWatched(),
                soundOn: notificationSoundEnabled()
            });
            // Somebody is reading it, here or in another tab of this browser.
            if (!alert.toast && !alert.sound && !alert.desktop) continue;
            // Read while this was being asked for, here or in another tab.
            if (caughtUp.current.has(message.channelId)) continue;
            const arrivedAt = heard.get(message.channelId) ?? Date.now();
            if (seenOnDevice(message.channelId, arrivedAt)) continue;
            // Already said, and saying it twice is not a second message.
            if (announced.current.get(message.channelId) === message.messageId) continue;
            announced.current.set(message.channelId, message.messageId);

            const who = message.inChannel
                ? `${message.authorName} in ${message.conversation}`
                : message.authorName;
            if (alert.toast) {
                const note: Toast = {
                    key: `message:${message.channelId}`,
                    title: who,
                    body: message.excerpt,
                    // Bounded both ways and never stretched: a tall photo is shown
                    // whole at a smaller size rather than cropped or squashed.
                    media: message.media ? (
                        <ToastPicture src={message.media.src} alt={message.excerpt} />
                    ) : undefined,
                    icon: (
                        <Avatar
                            size={28}
                            person={{
                                id: message.authorId ?? message.channelId,
                                name: message.authorName
                            }}
                        />
                    ),
                    onPress: () => go.current(`/chat/c/${message.channelId}/${message.messageId}`)
                };
                raise.current(note);
            }

            // Heard, not only seen. A silent card in the corner of a screen
            // somebody is typing on is a message they find later; every
            // messenger makes a noise for the same reason. Once for the batch,
            // and once for the device rather than once per open tab - the tabs
            // settle between themselves which of them makes it, because on an
            // install served over plain http they all believe they hold the
            // connection; see `device-once`.
            if (alert.sound && !sounded) {
                sounded = true;
                void claimForDevice(`${device.current}:message-chime`).then((mine) => {
                    if (mine) playCallSound("message");
                });
            }

            // Past the window as well, when nobody is looking at it, and drawn
            // once however many tabs this browser has open on it.
            if (alert.desktop) {
                void claimForDevice(`${device.current}:message-notice:${message.channelId}`).then(
                    (mine) => {
                        if (!mine) return;
                        void notifyDesktop({
                            title: who,
                            body: message.excerpt,
                            tag: `message:${message.channelId}`,
                            href: `/chat/c/${message.channelId}/${message.messageId}`
                        });
                    }
                );
            }
        }
    }, []);

    useChatStream(
        useCallback(
            (frame, context) => {
                // Read, somewhere. The notice and the card belong to the tab
                // that raised them, which is usually not the tab the reader
                // caught up in - and a notice offering a message they have just
                // read sends them back to it. The frame reaches every tab of
                // this account, which is what makes this work across windows.
                if (frame.kind === "read") {
                    if (frame.userId !== device.current) return;
                    // Put back to unread on purpose. Withdrawing the notice for
                    // it would undo exactly what they asked for.
                    if (frame.unread) return;
                    pending.current.delete(frame.channelId);
                    announced.current.delete(frame.channelId);
                    caughtUp.current.add(frame.channelId);
                    closeDesktopNotice(`message:${frame.channelId}`);
                    drop.current(`message:${frame.channelId}`);
                    return;
                }
                if (frame.kind !== "posted") return;
                // A tab that is neither being looked at nor holding the
                // connection has nobody to tell and nothing to draw.
                if (!context.owner && !tabIsWatched()) return;

                const attended = tabIsWatched();
                for (const channelId of frame.channels) {
                    // Being read right here: the line is on screen, and the
                    // other tabs are told so they stay quiet about it too.
                    if (attended && showsConversation(here.current, channelId)) {
                        markSeenOnDevice(channelId);
                        continue;
                    }
                    caughtUp.current.delete(channelId);
                    pending.current.set(channelId, Date.now());
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
