"use client";

/**
 * Whether the App Router has finished arriving, so it is safe to talk to it.
 *
 * A page that redirects while it renders - a list somebody lost access to, a
 * screen their role does not open - is answered inside its loading boundary, so
 * the redirect reaches the browser inside the stream and is carried out while
 * the first visit is still hydrating. If anything dispatches a router action in
 * that window - a server action, `router.refresh()` - the React that Next 15
 * ships commits a half-rendered router and the whole tab is replaced by
 * "Application error" (Minified React error #310). Measured here at 5-20 ms
 * after hydration on a local server, which is exactly when a mount effect runs.
 *
 * So code in the frame that has to reach the router on its own, without being
 * asked - reporting the device's time zone, settling the language - waits for
 * this. It is true once the document has finished streaming and either no
 * redirect was sent in it, or the redirect has already been carried out (the
 * path is no longer the one the document was served for). After that it stays
 * true for the life of the frame; later navigations are ordinary ones.
 *
 * The redirect is recognised by the `<meta id="__next-page-redirect">` Next
 * writes into the stream for browsers without JavaScript. If a future Next stops
 * writing it this degrades to "settled once the document has loaded", which is
 * what every caller did before.
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export const STREAMED_REDIRECT_MARKER = "__next-page-redirect";

/** The decision, apart from React: settled unless a redirect sent in the stream
 *  has yet to move the router off the path the document was served for. */
export function routerSettled(redirectInStream: boolean, served: string, current: string): boolean {
    return !redirectInStream || current !== served;
}

export function useRouterSettled(): boolean {
    const pathname = usePathname();
    const [served] = useState(pathname);
    const [settled, setSettled] = useState(false);

    useEffect(() => {
        if (settled) return;
        const decide = () => {
            const redirect = document.getElementById(STREAMED_REDIRECT_MARKER) !== null;
            if (routerSettled(redirect, served, pathname)) setSettled(true);
        };
        // Until the stream has ended a redirect may still be on its way.
        if (document.readyState !== "loading") {
            decide();
            return;
        }
        document.addEventListener("DOMContentLoaded", decide, { once: true });
        return () => document.removeEventListener("DOMContentLoaded", decide);
    }, [pathname, served, settled]);

    return settled;
}
