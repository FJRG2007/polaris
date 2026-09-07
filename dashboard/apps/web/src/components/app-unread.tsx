"use client";

/**
 * What is waiting, by the app it is waiting in.
 *
 * One list, read by everything that draws a badge: the app switcher's entries,
 * the dot on the switcher itself, the rail, and the number on the tab icon. The
 * reason it exists is a bug rather than a tidiness: each of those places had
 * written out "chat, or mail" for itself, and when Mail learned to count, three
 * of them were taught and the fourth was not - so the switcher showed a number
 * against Mail and no dot to say a number was there, which is precisely the
 * thing a dot is for.
 *
 * Anything that adds a fifth place to look, or a third app that can be waited
 * on, adds it here and every badge in Polaris follows. Nothing downstream is
 * allowed to name an app again.
 */

import { useMemo } from "react";
import { useChatUnread } from "@/components/chat-unread";
import { useMailUnread } from "@/components/mail-unread";

/** How much is waiting in each app, by the id the app catalogue uses. Apps with
 *  nothing to count are simply absent rather than zero, so a caller can ask
 *  `?? 0` and be right either way. */
export type AppUnread = Readonly<Record<string, number>>;

/**
 * The counts, gathered.
 *
 * Both providers already hold their own number and both are above every screen,
 * so this costs nothing beyond the object it builds: no request, no stream, no
 * state of its own.
 */
export function useAppUnread(): AppUnread {
    const chat = useChatUnread();
    const mail = useMailUnread();
    return useMemo(() => ({ chat: chat.messages, mail: mail.messages }), [chat.messages, mail.messages]);
}

/** Whether anything anywhere is waiting, which is the whole question a dot on
 *  the switcher answers. Derived rather than listed, so an app that starts
 *  counting raises it without anybody remembering to. */
export function anythingWaiting(unread: AppUnread): boolean {
    return Object.values(unread).some((count) => count > 0);
}

/** Everything waiting, as one number - for the tab icon, which has room for
 *  one. Which app it came from is a question the page itself answers. */
export function totalWaiting(unread: AppUnread): number {
    return Object.values(unread).reduce((sum, count) => sum + count, 0);
}
