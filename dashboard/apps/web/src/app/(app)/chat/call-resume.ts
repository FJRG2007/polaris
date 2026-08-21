"use client";

/**
 * Walking back into the call a reload took you out of.
 *
 * Polaris updating under an open tab offers a reload, and taking that offer
 * while on a call used to hang up: the tab was replaced, the room lost its
 * participant, and the person came back to a dashboard with no call in it and
 * no idea whether the others could still hear them. So the offer was one nobody
 * on a call could accept, which is the worst kind of update prompt - the one
 * people learn to dismiss.
 *
 * So the call is written down on the way out and picked up on the way in. To the
 * person it reads as what it is: the page reloaded, and they are still in the
 * call.
 *
 * Deliberately only for that button. A reload somebody typed is a reload they
 * meant, and rejoining a call they had walked away from would be a microphone
 * opening itself.
 *
 * Kept in this tab's own storage, which is the exact lifetime wanted: a reload
 * keeps it, closing the tab throws it away, and another tab never sees it. It
 * also outlives nothing else - the note is read once and removed, so a later
 * reload does not walk back into a call that finished an hour ago.
 */

import type { CallSession } from "./call-hold";

const KEY = "polaris.call.resume";

/**
 * How long a note is worth acting on.
 *
 * A reload is seconds. This is long enough to cover a slow one on a phone and
 * short enough that a tab which was left mid-reload, or restored by a browser
 * hours later, does not put somebody back on a call unasked.
 */
const WINDOW_MS = 90_000;

interface Note {
    readonly session: CallSession;
    readonly video: boolean;
    /** Who was on the call. A tab that signed out and back in as somebody else
     *  is not the same person, and their call is not this one's to rejoin. */
    readonly viewerId: string;
    readonly at: number;
}

/** Write down the call this tab is on, because it is about to be replaced. */
export function rememberCall(session: CallSession, video: boolean, viewerId: string): void {
    if (typeof window === "undefined") return;
    try {
        const note: Note = { session, video, viewerId, at: Date.now() };
        window.sessionStorage.setItem(KEY, JSON.stringify(note));
    } catch {
        // Storage refused - a browser with it off, or a full quota. The reload
        // still happens; it just does not carry the call.
    }
}

/**
 * The call this tab was on, once.
 *
 * Removed as it is read, whether or not it is used: a note that is left behind
 * is a note that fires on the next reload too.
 */
export function takeRememberedCall(viewerId: string): { session: CallSession; video: boolean } | null {
    if (typeof window === "undefined") return null;
    let raw: string | null = null;
    try {
        raw = window.sessionStorage.getItem(KEY);
        window.sessionStorage.removeItem(KEY);
    } catch {
        return null;
    }
    if (!raw) return null;

    try {
        const note = JSON.parse(raw) as Partial<Note>;
        const session = note.session;
        if (!session || typeof session.meetingId !== "string" || typeof session.channelId !== "string") return null;
        if (note.viewerId !== viewerId) return null;
        if (typeof note.at !== "number" || Date.now() - note.at > WINDOW_MS) return null;
        return { session, video: note.video === true };
    } catch {
        return null;
    }
}
