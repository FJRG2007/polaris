"use client";

/**
 * Notes down where the reader has been, for the Overview's "Recently visited"
 * card.
 *
 * Mounted once in the dashboard shell rather than per screen, so a page added
 * anywhere is remembered without doing anything. It writes to this browser's
 * storage and nowhere else - see recent-places - so a navigation costs a
 * localStorage write and no request at all.
 *
 * The heading is read a tick after the navigation, because the h1 belongs to the
 * page being navigated to and is not in the document yet when the path changes.
 * Whatever is there by then is what the visit is filed under; a screen that is
 * still resolving simply falls back to the name the registry has for it.
 *
 * It also counts each time an app is opened - moving into it from another app,
 * or loading the dashboard on it - which is what orders the app menu (see
 * `app-usage`). Moving between screens of one app is not another open.
 */

import { useEffect, useRef } from "react";
import { resolveActiveApp } from "@/lib/apps";
import { usePathname } from "next/navigation";
import { rememberAppOpen } from "@/lib/app-usage";
import { rememberPlace } from "@/lib/overview/recent-places";
import { describePlace, isRecordablePlace } from "@/lib/overview/place-labels";

/** Long enough for the page's own heading to have rendered, short enough that
 *  somebody passing straight through a screen is not recorded as having been
 *  there. */
const SETTLE_MS = 900;

export function VisitRecorder() {
    const pathname = usePathname();
    const lastApp = useRef<string | null>(null);

    useEffect(() => {
        const appId = resolveActiveApp(pathname).id;
        if (appId === lastApp.current) return;
        lastApp.current = appId;
        rememberAppOpen(appId);
    }, [pathname]);

    useEffect(() => {
        if (!isRecordablePlace(pathname)) return;
        const timer = setTimeout(() => {
            const heading = document.querySelector("main h1, h1")?.textContent ?? null;
            const place = describePlace(pathname, heading);
            rememberPlace({ href: pathname, label: place.label, context: place.context });
        }, SETTLE_MS);
        return () => clearTimeout(timer);
    }, [pathname]);

    return null;
}
