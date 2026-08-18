"use client";

/**
 * Puts the unread count on the tab icon. Reads the same live feed the bell does,
 * so the badge appears the moment an alert arrives and clears as soon as one is
 * read - on this tab or on another device. Renders nothing itself.
 *
 * Chat is counted here as well, even though a message never reaches the bell.
 * The bell is for things that happened to you and can be read later; a message
 * is somebody waiting. Left out, a person working in another app had a plain
 * icon on the tab and no way at all of learning one had arrived - which is the
 * one place a tab icon is worth anything, since by definition they are not
 * looking at the page.
 */

import { useEffect, useRef } from "react";
import { badgeLabel } from "@/lib/notification-badge";
import { useChatUnread } from "@/components/chat-unread";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { applyFavicon, currentFavicon, drawFavicon, type FaviconLink } from "@/lib/favicon";

export function NotificationFavicon() {
    const { unread } = useNotificationFeed();
    const chat = useChatUnread();
    // One number, because the icon has room for one. What it means is "there is
    // something here for you", and which half it came from is a question the
    // page itself answers.
    const waiting = unread + chat.messages;
    // The plain icon the page was served with. Kept so a feed that empties puts
    // back the crisp vector rather than a drawn copy of it.
    const plain = useRef<FaviconLink | null>(null);

    useEffect(() => {
        plain.current ??= currentFavicon();
        const label = badgeLabel(waiting);
        if (!label) {
            applyFavicon(plain.current);
            return;
        }
        const badged = drawFavicon(label);
        if (badged) applyFavicon({ href: badged, type: "image/png" });
    }, [waiting]);

    useEffect(() => () => {
        if (plain.current) applyFavicon(plain.current);
    }, []);

    return null;
}
