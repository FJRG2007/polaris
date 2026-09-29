"use client";

/**
 * Mounted on a screen a badge points at: opening it marks what is there as seen,
 * and the badge is asked for again at once rather than at the next frame.
 * Whether that clears it is the reader's setting; see `badge-seen.ts`.
 *
 * Its own module because it calls a server action: the badge provider is above
 * every screen and must not drag the session layer in with it.
 */

import { useEffect } from "react";
import type { BadgeScreen } from "@/lib/badge-seen";
import { useAdminRecount } from "@/components/admin-waiting";
import { markBadgeSeenAction } from "@/app/(app)/badge-actions";

export function SeenOnVisit({ screen }: { screen: BadgeScreen }) {
    const recount = useAdminRecount();
    useEffect(() => {
        void markBadgeSeenAction(screen)
            .then(recount)
            .catch(() => undefined);
    }, [screen, recount]);
    return null;
}
