"use client";

/**
 * Puts the unread count on the tab icon. Reads the same live feed the bell does,
 * so the badge appears the moment an alert arrives and clears as soon as one is
 * read - on this tab or on another device. Renders nothing itself.
 */

import { useEffect, useRef } from "react";
import { badgeLabel } from "@/lib/notification-badge";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { applyFavicon, currentFavicon, drawFavicon, type FaviconLink } from "@/lib/favicon";

export function NotificationFavicon() {
    const { unread } = useNotificationFeed();
    // The plain icon the page was served with. Kept so a feed that empties puts
    // back the crisp vector rather than a drawn copy of it.
    const plain = useRef<FaviconLink | null>(null);

    useEffect(() => {
        plain.current ??= currentFavicon();
        const label = badgeLabel(unread);
        if (!label) {
            applyFavicon(plain.current);
            return;
        }
        const badged = drawFavicon(label);
        if (badged) applyFavicon({ href: badged, type: "image/png" });
    }, [unread]);

    useEffect(() => () => {
        if (plain.current) applyFavicon(plain.current);
    }, []);

    return null;
}
