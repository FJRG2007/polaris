"use client";

import { useSyncExternalStore } from "react";

/** Below `sm`, where menus open as sheets rather than hanging off their button. */
export const PHONE_QUERY = "(max-width: 639px)";

/** Whether the screen is a phone's. Not on the server, where the menu is drawn. */
export function usePhone(): boolean {
    return useSyncExternalStore(
        (notify) => {
            if (typeof window.matchMedia !== "function") return () => undefined;
            const query = window.matchMedia(PHONE_QUERY);
            query.addEventListener("change", notify);
            return () => query.removeEventListener("change", notify);
        },
        () => typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches,
        () => false
    );
}

/** A control's height and width on a touch screen: what a finger can hit. */
export const TOUCH_TARGET = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
