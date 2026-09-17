"use client";

/**
 * The calls this reader has put away.
 *
 * Deciding not to watch a call is a decision that has to outlive the screen it
 * was made on. Held in component state it lasted until the next conversation
 * was opened or the page was reloaded, and the panel somebody had just dismissed
 * came straight back - which reads as the dismissal not working at all.
 *
 * Remembered by the call rather than by the conversation: a room somebody folded
 * away for good is a room where the next call is invisible again, so the id of
 * the meeting is what is stored, and the next call has an id of its own.
 *
 * Per browser, like the call volumes and the microphone cleanup: it is a
 * statement about the screen somebody is reading on, not about their account.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.chat.calls-hidden";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:chat-calls-hidden";

/**
 * How many are kept.
 *
 * A call that has ended is never asked about again, so the list only ever grows
 * with calls somebody dismissed and it would grow forever. Twenty is far more
 * than anybody has running at once, and the oldest falling off the end costs
 * nothing: that call is over.
 */
const KEPT = 20;

function read(): readonly string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return [];
        const held: unknown = JSON.parse(raw);
        // Written by an older Polaris, or by hand: anything that is not a list
        // of ids is nothing this reader put away.
        if (!Array.isArray(held)) return [];
        return held.filter((entry): entry is string => typeof entry === "string");
    } catch {
        // Storage refused, or the value is not readable. Showing the call is
        // the safe way to be wrong: it can be put away again.
        return [];
    }
}

/** Whether this call was put away here. */
export function callHidden(meetingId: string): boolean {
    return read().includes(meetingId);
}

export function setCallHidden(meetingId: string, hidden: boolean): void {
    if (typeof window === "undefined") return;
    const was = read();
    const next = hidden
        ? [meetingId, ...was.filter((entry) => entry !== meetingId)].slice(0, KEPT)
        : was.filter((entry) => entry !== meetingId);
    try {
        if (next.length === 0) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // It still applies to this tab; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/**
 * Whether this call is put away, and the switch.
 *
 * Read after mount rather than during render: the server has no local storage,
 * and a value read while rendering would not match what it sent.
 */
export function useCallHidden(meetingId: string | null): [boolean, (hidden: boolean) => void] {
    const [hidden, setHidden] = useState(false);
    useEffect(() => {
        if (!meetingId) {
            setHidden(false);
            return;
        }
        const onChange = () => setHidden(callHidden(meetingId));
        onChange();
        window.addEventListener(CHANGED, onChange);
        window.addEventListener("storage", onChange);
        return () => {
            window.removeEventListener(CHANGED, onChange);
            window.removeEventListener("storage", onChange);
        };
    }, [meetingId]);
    const change = useCallback(
        (next: boolean) => {
            if (!meetingId) return;
            setHidden(next);
            setCallHidden(meetingId, next);
        },
        [meetingId]
    );
    return [hidden, change];
}
