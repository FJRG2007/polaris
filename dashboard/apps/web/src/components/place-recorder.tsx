"use client";

/**
 * Records the screen an app is on, so the switcher can bring the reader back to
 * it rather than to the app's front door.
 *
 * Mounted inside an app's layout, which is what makes it cost nothing anywhere
 * else and what keeps the rule about which paths are worth remembering next to
 * the app that owns them.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { rememberPlace } from "@/lib/last-place";

export function PlaceRecorder({
    appId,
    root,
    skip = []
}: {
    appId: string;
    /** The app's front door. It is never remembered: coming back to where you
     *  already start is not something to store. */
    root: string;
    /** Paths under the root that are not worth returning to - a deep link to one
     *  record, which may not be there next time. Matched as prefixes. */
    skip?: readonly string[];
}) {
    const pathname = usePathname();
    useEffect(() => {
        if (!pathname.startsWith(`${root}/`)) return;
        if (skip.some((prefix) => pathname.startsWith(prefix))) return;
        rememberPlace(appId, pathname);
        // `skip` is a literal at every call site, so a new array identity on each
        // render would re-run this for nothing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appId, root, pathname]);
    return null;
}
