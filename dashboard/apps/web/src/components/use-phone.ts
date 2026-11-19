"use client";

import { onScreenKeyboard } from "@/lib/enter-key";
import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Below `sm`, where menus open as sheets rather than hanging off their button.
 *
 * By width alone, deliberately, and the same width the CSS lays the screen out
 * by: a phone turned sideways is a wide, short window and gets the wider layout
 * (the "compact height" case of Material's window size classes), an unfolded
 * foldable gets the tablet one and a folded one the phone one. It is a live
 * media query, so turning or unfolding the phone switches it as it happens.
 */
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

/**
 * Whether the keyboard on screen already dictates, so Polaris offers no
 * dictation button of its own: a phone-sized screen (the Android app's WebView
 * can report a fine pointer), or touch with no mouse beside it
 * (`onScreenKeyboard`). Asked after mount, since the server drew the button.
 */
export function useKeyboardDictates(): boolean {
    const phone = usePhone();
    const [touchOnly, setTouchOnly] = useState(false);
    useEffect(() => setTouchOnly(onScreenKeyboard()), []);
    return phone || touchOnly;
}

/** A control's height and width on a touch screen: what a finger can hit. */
export const TOUCH_TARGET = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
