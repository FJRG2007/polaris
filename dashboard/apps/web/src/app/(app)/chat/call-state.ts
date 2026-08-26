/**
 * What a call looks like to the screens that draw one.
 *
 * Separate from the hook that fills it in, so the grid, the audio, the controls
 * and the guest page are written against a shape rather than against a
 * connection - and none of them mentions the media server, which is the only
 * thing that carries a call here.
 */

import type { MeetingView } from "@/lib/chat/meetings";
import type { FilteredMic, MicFilter } from "./mic-filter";
import type { CallLevel, CallQuality } from "./call-quality";
import type { AudioRole, CombineRequest } from "./call-combine";

/** What somebody else's controls are set to, as far as they have said. */
export interface PeerState {
    readonly muted: boolean;
    readonly deafened: boolean;
    /** Whether they are writing this call to a file. */
    readonly recording: boolean;
    /** The seat they are listening through, for people sitting in one room
     *  sharing one microphone between their devices - see `call-combine`. Null
     *  for an ordinary device, which is almost everybody. */
    readonly group: string | null;
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
    /** This browser's own screen, while it is sharing one. Kept apart from the
     *  stream above so the room can put it where every other screen goes -
     *  folded in, the one person who could not see the share was the sharer. */
    readonly localScreen: MediaStream | null;
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
    /** When the room's own chat last changed, as a moment in time. What was said
     *  is read from the server by whatever draws it; this is the nudge that
     *  there is something new to read, so nothing has to poll. */
    readonly saidAt: number;
    /** What went wrong, in a sentence the call screen can show. Most often the
     *  browser refusing the camera, which is the reader's decision to reverse. */
    readonly error: string;
    readonly microphones: readonly CallDevice[];
    readonly cameras: readonly CallDevice[];
    readonly microphoneId: string | null;
    readonly cameraId: string | null;
    /** How much picture to send, as chosen. `auto` is the default and means the
     *  connection decides - see `call-quality`. */
    readonly cameraQuality: CallQuality;
    readonly screenQuality: CallQuality;
    /** What is actually going out. The same as the setting unless it is `auto`,
     *  in which case this is where the connection has settled - which is worth
     *  showing, because "automatic" with no number is a shrug. */
    readonly cameraLevel: CallLevel;
    readonly screenLevel: CallLevel;
    setCameraQuality: (value: CallQuality) => void;
    setScreenQuality: (value: CallQuality) => void;
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

    /**
     * Everybody in this call whose device this one can hear in the room around
     * it - see `call-nearby`. A suggestion and never an instruction: nothing is
     * combined without somebody pressing something.
     */
    readonly nearby: ReadonlySet<string>;

    /** The part this browser plays in its audio group, or null when it is in
     *  none - which is every ordinary call. */
    readonly audioRole: AudioRole | null;
    /** The seat of the device carrying the room for the group. */
    readonly audioHost: string | null;
    /** The other seats in the group. */
    readonly audioMembers: readonly string[];
    /** Somebody this browser has asked to go quiet, until they answer. */
    readonly combineAsked: string | null;
    /** Somebody asking this browser to go quiet, until it answers. */
    readonly combineRequest: CombineRequest | null;
    /** Go quiet and let their device carry the room. Changes nothing for
     *  anybody else, which is why it needs nobody's permission. */
    combineWith: (participantId: string) => void;
    /** Ask them to go quiet while this device carries the room. It turns off
     *  their microphone and their speakers, so it is a request rather than an
     *  instruction. */
    askToCombine: (participantId: string) => void;
    answerCombine: (accept: boolean) => void;
    leaveCombine: () => void;

    /** Whether this browser is announcing that it is recording. What is actually
     *  being written lives with the recorder - see `call-recorder`; this is the
     *  half everybody else in the call can see. */
    readonly recording: boolean;
    setRecording: (on: boolean) => void;
}
