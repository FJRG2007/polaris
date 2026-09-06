"use client";

/**
 * Whether this reader wants covers taken off for them.
 *
 * Off by default, and that is the only defensible default: a cover exists
 * because a sender decided the thing under it should not arrive unasked, and a
 * product that ignored that by default would make marking something pointless.
 *
 * On is for somebody who has decided, for themselves, that they would rather
 * see everything - which is a real preference and one every client of this kind
 * offers.
 *
 * Per browser rather than per account, like the call volumes and the microphone
 * cleanup: it is a statement about the screen somebody is reading on. The laptop
 * at home and the one in an office want different answers, and the answer that
 * matters is the one for the room they are actually in.
 */

import { useEffect, useState } from "react";

const KEY = "polaris.chat.spoilers-shown";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:chat-spoilers-shown";

export function spoilersShown(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(KEY) === "1";
    } catch {
        // Storage refused - a browser with it disabled, or a full quota. Covered
        // is the safe way to be wrong.
        return false;
    }
}

export function setSpoilersShown(shown: boolean): void {
    if (typeof window === "undefined") return;
    try {
        if (shown) window.localStorage.setItem(KEY, "1");
        else window.localStorage.removeItem(KEY);
    } catch {
        // It still applies to this tab; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/** The setting, live. Read after mount rather than during render: the server has
 *  no local storage, and a value read while rendering would not match what it
 *  sent. */
export function useSpoilersShown(): boolean {
    const [shown, setShown] = useState(false);
    useEffect(() => {
        setShown(spoilersShown());
        const onChange = () => setShown(spoilersShown());
        window.addEventListener(CHANGED, onChange);
        window.addEventListener("storage", onChange);
        return () => {
            window.removeEventListener(CHANGED, onChange);
            window.removeEventListener("storage", onChange);
        };
    }, []);
    return shown;
}
