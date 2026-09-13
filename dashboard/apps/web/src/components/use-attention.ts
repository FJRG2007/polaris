"use client";

/**
 * Whether somebody is actually attending to this tab.
 *
 * Two questions, and both have to be yes. `visibilityState` answers the first:
 * a backgrounded tab and a minimised window are `hidden`, and a browser reports it
 * promptly. It does not answer the second - a window with a video call, an editor
 * or a game on top of it is still `visible`, because nothing about the page
 * changed, only what is in front of it. `document.hasFocus()` is what notices
 * that, and the pair of them is as close as a browser lets anybody get to "this
 * person is looking at this".
 *
 * It exists because two things were treating "the page is mounted" as "the reader
 * is reading": the conversation marking messages read, and the presence report
 * that decides an alert arrived at somebody already watching. Both were wrong in
 * the same direction - the one that loses a message quietly - so the rule lives in
 * one place and both ask it.
 *
 * Erring is deliberate in the other direction: an unfocused window counts as not
 * reading, so the worst this does is leave a conversation bold and raise an alert
 * for something that had in fact been seen. That is recoverable by glancing at it.
 * The opposite - a read receipt for a message nobody read, and no notification -
 * is not recoverable at all, because nothing afterwards says it happened.
 */

import type { RefObject } from "react";
import { useEffect, useRef } from "react";

/**
 * The decision, given what the document says. Pure, and tested, because it is one
 * boolean expression that is easy to write inverted and impossible to see wrong:
 * both mistakes look like a working product until somebody misses a message.
 */
export function attending(visibility: string, focused: boolean): boolean {
    return visibility === "visible" && focused;
}

/** What the document says right now, or attending when there is no document
 *  (the server, where nothing is being read and nothing is being marked). */
function attendingNow(): boolean {
    if (typeof document === "undefined") return true;
    return attending(document.visibilityState, document.hasFocus());
}

/**
 * A ref that tracks whether this tab is being attended to, and a callback for the
 * moment it starts being.
 *
 * A ref rather than state on purpose. Every consumer so far reads it from inside a
 * callback that must not be rebuilt on each change - re-creating the conversation's
 * catch-up on every window blur would churn an effect that runs against the
 * message list - and none of them draw anything differently.
 *
 * `onReturn` is what makes coming back work. Somebody who left the tab at the
 * bottom of a conversation and comes back to it has now read what arrived while
 * they were away, and without this the channel would stay bold until the next
 * message showed up.
 */
export function useAttention(onReturn?: () => void): RefObject<boolean> {
    const present = useRef(attendingNow());
    const returned = useRef(onReturn);
    returned.current = onReturn;

    useEffect(() => {
        function settle(): void {
            const now = attendingNow();
            const gained = now && !present.current;
            present.current = now;
            if (gained) returned.current?.();
        }

        settle();
        document.addEventListener("visibilitychange", settle);
        // Focus and blur are on the window: they are what a program opening over
        // the browser changes, and the document's visibility is not.
        window.addEventListener("focus", settle);
        window.addEventListener("blur", settle);
        return () => {
            document.removeEventListener("visibilitychange", settle);
            window.removeEventListener("focus", settle);
            window.removeEventListener("blur", settle);
        };
    }, []);

    return present;
}
