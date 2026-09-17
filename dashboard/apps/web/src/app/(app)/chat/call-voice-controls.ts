/**
 * What the microphone and deafen buttons do to each other.
 *
 * The rules every voice client settled on:
 *
 * - Deafening mutes the microphone too: somebody who cannot hear the room is not
 *   talking to it.
 * - Undeafening gives back the microphone as it was before deafening. Somebody
 *   who muted and then deafened is still muted afterwards.
 * - Unmuting while deafened undeafens as well, since talking to people you
 *   cannot hear is never what the press meant.
 * - A device that is quiet for a room (see `call-combine`) never gets its
 *   microphone back from undeafening; unmuting is how it leaves the group.
 *
 * Decided here from the person's intent (`micOn`), never from the track's
 * `enabled` flag: push to talk and voice activity close the track between
 * sentences, and reading that as "muted" turned the mute button into a no-op.
 */

export interface VoiceControls {
    /** Whether the person wants to be heard. */
    readonly micOn: boolean;
    readonly deafened: boolean;
    /** Whether the microphone was on when deafening started. */
    readonly micBeforeDeafen: boolean;
}

export interface VoiceChange extends VoiceControls {
    /** Whether this press also takes the device out of its audio group. */
    readonly leaveGroup: boolean;
}

/** The mute button. */
export function pressMic(state: VoiceControls, companion: boolean): VoiceChange {
    if (state.micOn) {
        return { ...state, micOn: false, leaveGroup: false };
    }
    // Unmuting is somebody asking to be heard: out of deafen, and out of the
    // group whose device is carrying their voice.
    return {
        micOn: !companion,
        deafened: false,
        micBeforeDeafen: state.micBeforeDeafen,
        leaveGroup: companion
    };
}

/** The deafen button. */
export function pressDeafen(state: VoiceControls, companion: boolean): VoiceChange {
    if (!state.deafened) {
        return { micOn: false, deafened: true, micBeforeDeafen: state.micOn, leaveGroup: false };
    }
    return {
        micOn: state.micBeforeDeafen && !companion,
        deafened: false,
        micBeforeDeafen: state.micBeforeDeafen,
        leaveGroup: false
    };
}
