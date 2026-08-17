/**
 * What a call looks like to the screens that draw one.
 *
 * There are two ways Polaris carries a call - through a media server when one is
 * set up, and browser-to-browser when there is not - and neither of them is
 * something the call screen should have to know about. So the shape is written
 * once, here, and both implementations answer to it: the grid, the audio, the
 * controls and the guest page are the same code either way.
 */

import type { MeetingView } from "@/lib/chat/meetings";
import type { FilteredMic, MicFilter } from "./mic-filter";

/** What somebody else's controls are set to, as far as they have said. */
export interface PeerState {
    readonly muted: boolean;
    readonly deafened: boolean;
}

/** One microphone or camera, as the picker lists it. */
export interface CallDevice {
    readonly id: string;
    readonly label: string;
}

export interface CallState {
    readonly meeting: MeetingView | null;
    readonly participantId: string | null;
    readonly localStream: MediaStream | null;
    /** Remote camera and audio, by the participant id it belongs to. */
    readonly remote: ReadonlyMap<string, MediaStream>;
    /** Remote screens, by the participant id sharing one. Separate from their
     *  camera, because they are two different pictures of two different things
     *  and a room shows them differently. */
    readonly screens: ReadonlyMap<string, MediaStream>;
    /** The participant ids talking right now, this browser's own included. */
    readonly speaking: ReadonlySet<string>;
    /** What everybody else's microphone and headphones are set to, as far as
     *  they have said. Absent for somebody whose browser has not said yet, which
     *  draws as nothing rather than as "on". */
    readonly states: ReadonlyMap<string, PeerState>;
    readonly micOn: boolean;
    readonly cameraOn: boolean;
    /** Whether this browser has a camera to turn on at all. */
    readonly hasCamera: boolean;
    /** Whether a screen is going out. */
    readonly sharing: boolean;
    /** Whether everybody else is silenced here. Nobody else is told: it is a
     *  decision about this pair of ears. */
    readonly deafened: boolean;
    readonly ended: boolean;
    /** What went wrong, in a sentence the call screen can show. Most often the
     *  browser refusing the camera, which is the reader's decision to reverse. */
    readonly error: string;
    readonly microphones: readonly CallDevice[];
    readonly cameras: readonly CallDevice[];
    readonly microphoneId: string | null;
    readonly cameraId: string | null;
    /** How much is being done to what the microphone hears. */
    readonly cleanMic: MicFilter;
    setCleanMic: (level: MicFilter) => void;
    /** Which filter is actually running, or null for none. Not always the one
     *  asked for: a model can fail to start, and a licence can fail to load. */
    readonly micFilter: FilteredMic["using"] | null;
    /** Whether this instance has a licensed filter connected at all. */
    readonly licensedFilter: boolean;
    toggleMic: () => void;
    toggleCamera: () => void;
    toggleShare: () => void;
    toggleDeafen: () => void;
    chooseMicrophone: (deviceId: string) => void;
    chooseCamera: (deviceId: string) => void;
    refresh: () => void;
}
