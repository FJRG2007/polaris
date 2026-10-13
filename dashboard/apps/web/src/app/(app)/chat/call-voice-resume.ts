"use client";

/**
 * The microphone and the ears a reload takes out of a call.
 *
 * Reloading mid-call puts the person back in the room (see `call-resume`), but
 * the room used to open with their microphone live and their ears on: somebody
 * who was muted or deafened came back talking to everybody, with nothing they
 * pressed to say so. The per-browser mute (`call-muted`) only remembers the mute
 * button on purpose, so deafening - which silences the microphone too - was lost
 * on every reload.
 *
 * So the page writes down what the person had asked for as it is left, and the
 * same call reads it once as it opens, before anything is published. Kept in
 * this tab's own storage for the lifetime a reload needs: another tab never sees
 * it, a closed tab throws it away, and a note is read once and removed.
 */

const KEY = "polaris.call.voice";

/** Long enough for a slow reload, short enough not to outlive one. */
const WINDOW_MS = 90_000;

export interface ResumedVoice {
    /** Whether the person wanted to be heard, apart from deafening. */
    readonly micOn: boolean;
    readonly deafened: boolean;
    /** Whether the microphone was on when deafening started, so undeafening
     *  after the reload gives back what it would have before it. */
    readonly micBeforeDeafen: boolean;
}

interface Note extends ResumedVoice {
    readonly meetingId: string;
    readonly at: number;
}

/** Write down what this tab's voice is in this call, because the tab is about to
 *  be replaced. */
export function rememberVoice(meetingId: string, voice: ResumedVoice): void {
    if (typeof window === "undefined") return;
    try {
        const note: Note = { meetingId, at: Date.now(), ...voice };
        window.sessionStorage.setItem(KEY, JSON.stringify(note));
    } catch {
        // Storage refused. The call still comes back; it opens the default way.
    }
}

/** What this tab's voice was in this call before it reloaded, once. */
export function takeRememberedVoice(meetingId: string): ResumedVoice | null {
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
        const note = JSON.parse(raw) as Partial<Note> | null;
        if (!note || note.meetingId !== meetingId) return null;
        if (typeof note.at !== "number" || Date.now() - note.at > WINDOW_MS) return null;
        if (
            typeof note.micOn !== "boolean" ||
            typeof note.deafened !== "boolean" ||
            typeof note.micBeforeDeafen !== "boolean"
        )
            return null;
        return { micOn: note.micOn, deafened: note.deafened, micBeforeDeafen: note.micBeforeDeafen };
    } catch {
        return null;
    }
}
