"use client";

/**
 * Puts what is waiting on the tab icon. Reads the same live feed the bell does,
 * so the badge appears the moment an alert arrives and clears as soon as one is
 * read - on this tab or on another device. Renders nothing itself.
 *
 * Chat is counted here as well, even though a message never reaches the bell.
 * The bell is for things that happened to you and can be read later; a message
 * is somebody waiting. Left out, a person working in another app had a plain
 * icon on the tab and no way at all of learning one had arrived - which is the
 * one place a tab icon is worth anything, since by definition they are not
 * looking at the page.
 *
 * Whether that shows as a number, a dot, or nothing at all is the device's
 * choice - see `favicon-style` - and it is followed while the page is open, so
 * changing it in Settings redraws the tab there and then.
 */

import { useEffect, useRef, useState } from "react";
import { useChatUnread } from "@/components/chat-unread";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { applyFavicon, currentFavicon, drawFavicon, type FaviconLink } from "@/lib/favicon";
import {
    DEFAULT_FAVICON_STYLE,
    faviconBadge,
    faviconStyle,
    onFaviconStyleChange,
    type FaviconStyle
} from "@/lib/favicon-style";

export function NotificationFavicon() {
    const { unread } = useNotificationFeed();
    const chat = useChatUnread();
    // One number, because the icon has room for one. What it means is "there is
    // something here for you", and which half it came from is a question the
    // page itself answers.
    const waiting = unread + chat.messages;
    // Storage is not readable while the page is rendered on the server, so the
    // default holds until the first paint has happened.
    const [style, setStyle] = useState<FaviconStyle>(DEFAULT_FAVICON_STYLE);
    // The plain icon the page was served with. Kept so a feed that empties puts
    // back the crisp vector rather than a drawn copy of it.
    const plain = useRef<FaviconLink | null>(null);

    useEffect(() => {
        const read = () => setStyle(faviconStyle());
        read();
        return onFaviconStyleChange(read);
    }, []);

    useEffect(() => {
        plain.current ??= currentFavicon();
        const badge = faviconBadge(style, waiting);
        if (!badge) {
            applyFavicon(plain.current);
            return;
        }
        const badged = drawFavicon(badge);
        if (badged) applyFavicon({ href: badged, type: "image/png" });
    }, [style, waiting]);

    useEffect(() => () => {
        if (plain.current) applyFavicon(plain.current);
    }, []);

    return null;
}
