/**
 * The output this browser was told to play calls through, as stored.
 *
 * Read in two places that cannot share a module: the speaker picker inside a
 * call, and the tones every screen plays - an incoming ring included, which is
 * drawn outside any call. Kept here, free of React, so the second can follow the
 * first without pulling the picker into every page.
 */

const KEY = "polaris.call.speaker";

/** Same-tab announcement, since the storage event only reaches other tabs. */
export const SPEAKER_CHANGED = "polaris:call-speaker";

/** The one this browser has been told to use, or null for the system's own
 *  choice - which is what "Default" means and what most people want. */
export function speakerDevice(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(KEY) || null;
    } catch {
        return null;
    }
}

export function setSpeakerDevice(deviceId: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (deviceId) window.localStorage.setItem(KEY, deviceId);
        else window.localStorage.removeItem(KEY);
    } catch {
        // It still applies to what is playing now; it just will not be
        // remembered.
    }
    window.dispatchEvent(new Event(SPEAKER_CHANGED));
}
