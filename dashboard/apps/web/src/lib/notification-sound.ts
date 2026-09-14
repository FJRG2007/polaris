/**
 * The chime that plays when a notification arrives, and the switch governing it.
 *
 * The choice is kept per device rather than per account: whether sound is welcome
 * depends on the machine you are sitting at - a shared desk, a meeting room - not
 * on who is signed in. It starts on, so an alert is not silently missed by
 * somebody who never opened this setting.
 *
 * The tone is synthesised rather than shipped as an audio file: it is two short
 * notes, and generating them costs nothing to fetch and cannot arrive too late to
 * be heard.
 */

const STORAGE_KEY = "polaris.notifications.sound";

/**
 * The switch moved, told to whatever is listening on this page.
 *
 * The server decides which of an account's clients makes the sound and skips the
 * ones that have it switched off (see `notifications/live-clients`), so it has to
 * be told - and it is only ever told when a connection opens. Everything
 * following the stream therefore reconnects on this, together, so they go on
 * agreeing about one address for it. Announced here rather than from the settings
 * screen because this is the one place the choice is written.
 */
export const NOTIFICATION_SOUND_CHANGED = "polaris:notification-sound";

/** Mirrors storage so the choice still holds when a write is refused. */
let enabled: boolean | null = null;

let context: AudioContext | null = null;

/** On unless this device turned it off. */
export function notificationSoundEnabled(): boolean {
    if (enabled === null) {
        try {
            enabled = window.localStorage.getItem(STORAGE_KEY) !== "off";
        } catch {
            enabled = true;
        }
    }
    return enabled;
}

export function setNotificationSoundEnabled(next: boolean): void {
    enabled = next;
    try {
        window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
        // Private browsing refuses the write; the choice holds for this visit.
    }
    // Announced even when the write was refused: the choice holds for this visit
    // either way, and the server has to hear about it either way.
    try {
        window.dispatchEvent(new CustomEvent(NOTIFICATION_SOUND_CHANGED));
    } catch {
        // No window to tell - a server render, a test without a DOM.
    }
}

/**
 * Whether a feed snapshot brought an alert this tab has not shown yet, recording
 * every id it saw either way. Only an unread arrival counts: a frame that merely
 * reflects the same alerts read on another device is not news here, and the
 * snapshot taken at first paint must not chime for everything already waiting.
 */
export function hasNewArrival(seen: Set<string>, rows: Array<{ id: string; read: boolean; }>): boolean {
    let arrived = false;
    for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        if (!row.read) arrived = true;
    }
    return arrived;
}

/** A rising two-note chime. Silent rather than throwing when audio is unavailable. */
export function playNotificationSound(): void {
    try {
        context ??= new AudioContext();
        const audio = context;
        const ring = () => {
            const now = audio.currentTime;
            note(audio, 880, now, 0.16);
            note(audio, 1318.51, now + 0.11, 0.24);
        };
        // A context created before the page was interacted with starts suspended,
        // and notes scheduled while it is are dropped, so it is resumed first.
        if (audio.state === "suspended") void audio.resume().then(ring).catch(() => undefined);
        else ring();
    } catch {
        // No audio device, or a browser that will not start one. Nothing to recover.
    }
}

function note(audio: AudioContext, frequency: number, at: number, duration: number): void {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    // A sine cut off square is heard as a click, so each note is faded in and out.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.16, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + duration);
}
