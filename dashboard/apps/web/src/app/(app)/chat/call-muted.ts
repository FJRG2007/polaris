"use client";

/**
 * Whether this browser goes into a room with its microphone off.
 *
 * It exists because of what opening a voice channel now does: pressing the name
 * of a room puts you in it, with no second button. That is what every other
 * client does and it is what people expect - but on its own it means a press
 * opens a microphone, and a room that opens your microphone when you look at it
 * is a room people are afraid to look at.
 *
 * So the answer is remembered. Somebody who mutes themselves once walks into
 * every room after that muted, and somebody who never touches it never notices
 * this exists. It is the difference between a decision made once and a decision
 * demanded every time.
 *
 * Per browser, like the volumes and the microphone cleanup, and for the same
 * reason: it is a fact about a machine in a room, not about a person. The laptop
 * in the kitchen and the desk with the headset want different answers.
 */

const KEY = "polaris.call.muted";

/** Whether to start muted. Off for somebody who has never touched it: a call
 *  where nobody can hear you, and nothing said so, is the worse failure. */
export function callMuted(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(KEY) === "1";
    } catch {
        // Storage refused - a browser with it disabled, or a full quota.
        return false;
    }
}

export function setCallMuted(muted: boolean): void {
    if (typeof window === "undefined") return;
    try {
        if (muted) window.localStorage.setItem(KEY, "1");
        else window.localStorage.removeItem(KEY);
    } catch {
        // It still applies to this call; it just will not be remembered.
    }
}
