/**
 * The menu the share button opens while a screen is going out: stop, change
 * what is shared, how much picture, and whether its sound goes with it.
 *
 * Kept apart from the hook so the parts that decide something - what a press
 * does, what a new pick does to the publications, what a quality rung does to
 * the encoder - can be checked without a call server or a screen picker.
 */

/** What pressing the share button does right now. */
export type SharePress = "start" | "menu" | "none";

/**
 * Not sharing, it opens the picker as it always has; sharing, it opens the
 * menu. A browser that cannot share at all - every phone - has nothing to
 * start, though a share already running still gets its menu.
 */
export function sharePress(state: { sharing: boolean; canShare: boolean }): SharePress {
    if (state.sharing) return "menu";
    return state.canShare ? "start" : "none";
}

/** How the menu's rows are drawn. */
export interface ShareMenuRows {
    /** "Change stream" needs the picker, which a phone does not have. */
    readonly change: { readonly disabled: boolean };
    /** The sound box: ticked while the sound goes out, and locked with the
     *  reason when this share has no sound to send. */
    readonly audio: {
        readonly checked: boolean;
        readonly disabled: boolean;
        readonly reason: "no-sound" | null;
    };
}

export function shareMenuRows(state: {
    canShare: boolean;
    /** Whether the share being sent carries a sound track at all. */
    hasAudio: boolean;
    /** Whether that sound is going out. */
    audioOn: boolean;
    /** A change already waiting on the picker. */
    changing: boolean;
}): ShareMenuRows {
    return {
        change: { disabled: !state.canShare || state.changing },
        audio: {
            checked: state.hasAudio && state.audioOn,
            disabled: !state.hasAudio,
            reason: state.hasAudio ? null : "no-sound"
        }
    };
}

/** The tracks of the share going out. */
export interface ScreenTracks {
    readonly video: MediaStreamTrack;
    readonly audio: MediaStreamTrack | null;
}

/** What a change of stream came to. */
export type ScreenSwap =
    | { readonly kind: "kept" }
    | { readonly kind: "swapped"; readonly tracks: ScreenTracks }
    | { readonly kind: "failed"; readonly error: unknown };

/** Whether the picker was closed rather than failed: cancelled, or refused. */
export function pickerDeclined(error: unknown): boolean {
    const name = (error as Error | undefined)?.name;
    return name === "NotAllowedError" || name === "SecurityError" || name === "AbortError";
}

/**
 * Share something else without ending the share.
 *
 * The picture is swapped inside the publication that is already up, so
 * everybody watching keeps the same stream and only sees what is in it change.
 * The sound is the one part that can come or go: a tab with sound picked after
 * a window without is published beside the picture, and the other way round
 * takes the old sound down - the picture is not touched by either.
 *
 * Closing the picker keeps the current share exactly as it was. The old tracks
 * are only stopped once the new ones are on the wire.
 */
export async function swapScreen(deps: {
    current: ScreenTracks;
    /** Opens the picker. Must be called before anything is awaited, because
     *  the picker needs the press that asked for it. */
    open: () => Promise<MediaStream>;
    /** Puts a track in the picture's publication, in place of the old one.
     *  False when it could not, which leaves the old share running. */
    publishVideo: (track: MediaStreamTrack) => Promise<boolean>;
    /** Puts a track in the sound's publication, or takes it down for null. */
    publishAudio: (track: MediaStreamTrack | null) => Promise<unknown>;
}): Promise<ScreenSwap> {
    let stream: MediaStream;
    try {
        stream = await deps.open();
    } catch (error) {
        return pickerDeclined(error) ? { kind: "kept" } : { kind: "failed", error };
    }
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] ?? null;
    if (!video) {
        audio?.stop();
        return { kind: "kept" };
    }
    if (!(await deps.publishVideo(video))) {
        video.stop();
        audio?.stop();
        return { kind: "failed", error: new Error("The new picture could not be sent.") };
    }
    if (audio || deps.current.audio) await deps.publishAudio(audio);
    if (deps.current.video !== video) deps.current.video.stop();
    if (deps.current.audio && deps.current.audio !== audio) deps.current.audio.stop();
    return { kind: "swapped", tracks: { video, audio } };
}

/** A rung's allowance, as the encoder takes it. */
export interface ScreenEncoding {
    readonly maxBitrate: number;
    readonly maxFramerate: number;
}

/**
 * The sender's layers with a new allowance.
 *
 * The top layer - the one with the most to spend - is given the rung's
 * allowance outright; any smaller layer keeps its own, capped by the new one so
 * it can never outspend the top. A layer the client has switched off is left
 * as it is, since its numbers are the client's own placeholders.
 */
export function retargetEncodings(
    encodings: readonly RTCRtpEncodingParameters[],
    want: ScreenEncoding
): RTCRtpEncodingParameters[] {
    let top = -1;
    encodings.forEach((encoding, index) => {
        if (encoding.active === false) return;
        if (top < 0 || (encoding.maxBitrate ?? 0) > (encodings[top]?.maxBitrate ?? 0)) top = index;
    });
    return encodings.map((encoding, index) => {
        if (encoding.active === false) return { ...encoding };
        if (index === top) {
            return { ...encoding, maxBitrate: want.maxBitrate, maxFramerate: want.maxFramerate };
        }
        return {
            ...encoding,
            maxBitrate: Math.min(encoding.maxBitrate ?? want.maxBitrate, want.maxBitrate),
            maxFramerate: Math.min(encoding.maxFramerate ?? want.maxFramerate, want.maxFramerate)
        };
    });
}

/** The parts of a published screen track this needs. */
export interface EncodedTrack {
    readonly sender?: RTCRtpSender;
    publishOptions?: { screenShareEncoding?: { maxBitrate: number; maxFramerate?: number } };
    setDegradationPreference?: (preference: RTCDegradationPreference) => Promise<void>;
}

/**
 * Give a screen that is already published a new allowance, in place.
 *
 * The sender's own parameters are rewritten, so nobody watching resubscribes.
 * The publish options are updated too, because the client recomputes the
 * layers from them whenever the picture underneath changes size - a change of
 * stream would otherwise put the old allowance back.
 *
 * False when it could not be done here - no sender yet, or a browser that
 * refused the parameters - and the caller then publishes again instead.
 */
export async function retuneScreenEncoding(
    track: EncodedTrack | null | undefined,
    want: ScreenEncoding,
    preference: RTCDegradationPreference
): Promise<boolean> {
    const sender = track?.sender;
    if (!track || !sender) return false;
    try {
        const params = sender.getParameters();
        if (!params.encodings?.length) return false;
        params.encodings = retargetEncodings(params.encodings, want);
        await sender.setParameters(params);
    } catch {
        return false;
    }
    if (track.publishOptions) track.publishOptions.screenShareEncoding = { ...want };
    await track.setDegradationPreference?.(preference).catch(() => undefined);
    return true;
}
