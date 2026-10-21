"use client";

import { useSyncExternalStore } from "react";

const WIDE_QUERY = "(min-width: 768px)";

/** Whether the screen is wide enough for the sidebar beside the chat. Wide on
 *  the server and where there is no media query, which is what the CSS also
 *  assumes until the page is live. */
export function useWide(): boolean {
    return useSyncExternalStore(
        (notify) => {
            if (typeof window.matchMedia !== "function") return () => undefined;
            const query = window.matchMedia(WIDE_QUERY);
            query.addEventListener("change", notify);
            return () => query.removeEventListener("change", notify);
        },
        () =>
            typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY).matches : true,
        () => true
    );
}
