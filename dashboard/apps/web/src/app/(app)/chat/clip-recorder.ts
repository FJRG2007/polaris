"use client";

/**
 * Recording a screen, with a face on it if you want one.
 *
 * The thing people put off doing. Explaining a bug, walking somebody through a
 * screen, showing why the number is wrong - all of it is a minute of video and
 * twenty minutes of typing, and everybody types it instead, because recording
 * means finding a tool, recording, finding the file, and uploading it. Here it
 * is a button in the composer and the result is already attached.
 *
 * What it makes is one ordinary attachment: the same upload, the same storage,
 * the same limits, the same delete. Nothing new happens to the bytes.
 *
 * **The camera is drawn into the picture rather than sent beside it.** A second
 * track would need a player that knows about it, a layout for it, and a decision
 * about what to do when a client only plays one - so the two are composed onto a
 * canvas here, once, and what leaves the browser is a single video that plays
 * anywhere. The same argument settles the sound: the screen's audio and the
 * microphone are mixed into one track rather than sent as two.
 *
 * Everything is stopped on the way out, and that is not tidiness. A display
 * track left running keeps the browser's "sharing your screen" bar on the
 * screen, and a camera left open keeps its light on - both of which are alarming
 * and neither of which the person did.
 */

import { micGain } from "./mic-gain";
import { filterMic, type FilteredMic } from "./mic-filter";
import { micCleanup, micConstraints } from "./mic-cleanup";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long one may run.
 *
 * Ten minutes, and it is a ceiling rather than a target: the recording is held
 * whole in memory here, posted whole and held whole again on the way into
 * storage. Anything longer than this is a document rather than a clip, and the
 * attachment limit is what it would meet next anyway.
 */
export const MAX_CLIP_SECONDS = 600;

/** The widest the picture is composed at. A screen is often far wider than
 *  anything anybody will watch this on, and every extra pixel is bytes in a
 *  file with a size limit. */
const MAX_WIDTH = 1280;

/** How often the composed picture is drawn, and the rate the recorder is told to
 *  expect. Thirty is smooth enough to follow a pointer and half the bytes of
 *  sixty. */
const FPS = 30;

/**
 * What to record into, best first - and "best" is what the person receiving it
 * can open, not what is smallest.
 *
 * MP4 with H.264 first, wherever the browser will make one. WebM with VP9 is a
 * third smaller for the same picture, and it is the wrong default anyway: a
 * `.webm` will not open in most desktop players, will not go into a video
 * editor, and is a container decision nobody asked to make on behalf of whoever
 * is sent the file. Recording straight into MP4 is also the only honest way to
 * offer it as one - converting a video in a page means shipping a transcoder and
 * an afternoon of somebody's battery.
 *
 * WebM is what is left for a browser that will not record MP4, and it is played
 * back perfectly well by the browser that made it.
 */
const TYPES = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,opus",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
];

/** What this browser can record into, or null when it cannot record video. */
export function clipRecordingType(): string | null {
    if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
    return TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/**
 * Whether the button should exist at all.
 *
 * `getDisplayMedia` is the part that is missing rather than the recorder: no
 * phone browser has it, and offering a button that can only fail is worse than
 * not offering one.
 */
export function canRecordClip(): boolean {
    return (
        clipRecordingType() !== null &&
        typeof navigator?.mediaDevices?.getDisplayMedia === "function"
    );
}

/** The name a clip is sent under. Plain, like a voice message: the message says
 *  when it was made, and a name with a timestamp in it says it again. */
export function clipFileName(type: string): string {
    return `screen-clip.${type.startsWith("video/mp4") ? "mp4" : "webm"}`;
}

/** What to record, as the dialog asks for it. */
export interface ClipSources {
    /** Whether the person's own camera goes in the corner. */
    readonly camera: boolean;
    /** Whether their microphone is mixed in. */
    readonly microphone: boolean;
    /** Which camera, when there is more than one. Absent means whichever the
     *  browser hands over, which is right for the machine with one. */
    readonly cameraId?: string | null;
    /** Which microphone. Absent follows the choice made for calls and voice
     *  messages, which is the same headset - see `micConstraints`. */
    readonly microphoneId?: string | null;
}

export type ClipStage = "idle" | "starting" | "recording" | "paused" | "ready";

export interface ClipRecording {
    readonly stage: ClipStage;
    /** How long it has run for, in seconds, not counting time paused. */
    readonly seconds: number;
    /** What was recorded, once it is stopped. */
    readonly file: File | null;
    /** A URL for playing it back, revoked when it is thrown away. */
    readonly preview: string | null;
    readonly error: string;
    /** The composed picture, for the preview shown while it records. Null until
     *  a recording is running. */
    readonly canvas: HTMLCanvasElement | null;
    start: (sources: ClipSources) => Promise<void>;
    pause: () => void;
    resume: () => void;
    stop: () => void;
    /** Throw the recording away, ready to start again. */
    discard: () => void;
}

/**
 * The recorder, and everything it has to put back.
 *
 * A ref rather than state for all of it: none of it is drawn, several pieces are
 * touched from callbacks that would otherwise close over a stale copy, and the
 * cleanup has to be able to reach every one of them from an effect that runs
 * once.
 */
interface Machinery {
    recorder: MediaRecorder | null;
    display: MediaStream | null;
    camera: MediaStream | null;
    /** The stream actually being recorded - the canvas's, or the display's when
     *  there is no camera to compose. */
    recorded: MediaStream | null;
    audio: AudioContext | null;
    /** The cleanup and the level between the microphone and the recording, when
     *  either is asked for. */
    voice: FilteredMic | null;
    canvas: HTMLCanvasElement | null;
    frame: number | null;
    chunks: Blob[];
    bytes: number;
    /** Set while stopping on purpose, so the display track ending does not read
     *  as the person pressing the browser's own "stop sharing". */
    stopping: boolean;
}

export function useClipRecorder(options: { maxBytes: number }): ClipRecording {
    const [stage, setStage] = useState<ClipStage>("idle");
    const [seconds, setSeconds] = useState(0);
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

    const kit = useRef<Machinery>({
        recorder: null,
        display: null,
        camera: null,
        recorded: null,
        audio: null,
        voice: null,
        canvas: null,
        frame: null,
        chunks: [],
        bytes: 0,
        stopping: false
    });
    /** The ceiling, in a ref: the recorder's own handler is registered once and
     *  would otherwise hold whatever the limit was when it was. */
    const ceiling = useRef(options.maxBytes);
    ceiling.current = options.maxBytes;

    /** Everything opened, closed. Safe to call twice. */
    const teardown = useCallback(() => {
        const parts = kit.current;
        if (parts.frame !== null) cancelAnimationFrame(parts.frame);
        parts.frame = null;
        for (const stream of [parts.display, parts.camera, parts.recorded]) {
            stream?.getTracks().forEach((track) => track.stop());
        }
        parts.display = null;
        parts.camera = null;
        parts.recorded = null;
        void parts.voice?.stop().catch(() => undefined);
        parts.voice = null;
        void parts.audio?.close().catch(() => undefined);
        parts.audio = null;
        parts.recorder = null;
        parts.canvas = null;
        setCanvas(null);
    }, []);

    // The window closing on a recording still holds the camera and the screen.
    useEffect(() => () => teardown(), [teardown]);

    /** The clock. Runs only while recording, so a pause does not count. */
    useEffect(() => {
        if (stage !== "recording") return;
        const timer = setInterval(() => setSeconds((count) => count + 1), 1000);
        return () => clearInterval(timer);
    }, [stage]);

    const stop = useCallback(() => {
        const parts = kit.current;
        if (!parts.recorder || parts.recorder.state === "inactive") return;
        parts.stopping = true;
        parts.recorder.stop();
    }, []);

    // Stopped for them at the ceiling rather than silently cut off at it: the
    // recording is only useful whole, and one that ran past the limit would be
    // refused by the upload after they had made it.
    useEffect(() => {
        if (stage === "recording" && seconds >= MAX_CLIP_SECONDS) stop();
    }, [stage, seconds, stop]);

    const start = useCallback(
        async (sources: ClipSources) => {
            const type = clipRecordingType();
            if (!type) {
                setError("This browser cannot record video");
                return;
            }
            setError("");
            setStage("starting");
            const parts = kit.current;
            parts.chunks = [];
            parts.bytes = 0;
            parts.stopping = false;

            let display: MediaStream;
            try {
                // The browser asks which screen or window, and refusing that is
                // not an error worth a sentence - it is somebody changing their
                // mind, and the dialog they changed it in is already gone.
                display = await navigator.mediaDevices.getDisplayMedia({
                    video: { frameRate: FPS },
                    // Asked for and often refused: only Chrome shares a tab's
                    // sound, and a browser that will not is not a failure.
                    audio: true
                });
            } catch {
                setStage("idle");
                return;
            }
            parts.display = display;

            if (sources.camera || sources.microphone) {
                try {
                    parts.camera = await navigator.mediaDevices.getUserMedia({
                        video: sources.camera
                            ? {
                                  width: 640,
                                  height: 480,
                                  // Asked for rather than demanded: a camera that
                                  // has been unplugged since it was chosen should
                                  // fall back to another one, not refuse to
                                  // record.
                                  ...(sources.cameraId
                                      ? { deviceId: { ideal: sources.cameraId } }
                                      : {})
                              }
                            : false,
                        // The same cleanup a call uses, so somebody who turned it
                        // off there is not quietly given it back here - and the
                        // same microphone, unless this dialog was told otherwise.
                        audio: sources.microphone
                            ? micConstraints(sources.microphoneId ?? undefined)
                            : false
                    });
                } catch {
                    // The screen is already being shared and is the point of the
                    // recording; losing the face is worth saying and not worth
                    // abandoning it for.
                    setError(
                        sources.camera
                            ? "Recording without the camera - it could not be opened"
                            : "Recording without the microphone - it could not be opened"
                    );
                }
            }

            // The microphone gets the same cleanup and the same level it would
            // on a call: a clip recorded through the untouched microphone while
            // calls have the model on it is the same person sounding like two
            // different rooms.
            const spoken = parts.camera?.getAudioTracks()[0] ?? null;
            if (spoken) {
                parts.voice = await filterMic(spoken, micCleanup(), null, micGain()).catch(
                    () => null
                );
            }
            const audio = mixAudio(
                display,
                parts.voice ? new MediaStream([parts.voice.track]) : parts.camera
            );
            parts.audio = audio.context;

            let recorded: MediaStream;
            if (sources.camera && parts.camera?.getVideoTracks().length) {
                const composed = compose(display, parts.camera);
                if (!composed) {
                    teardown();
                    setStage("idle");
                    setError("This browser cannot compose the picture");
                    return;
                }
                parts.canvas = composed.canvas;
                parts.frame = composed.frame;
                setCanvas(composed.canvas);
                recorded = composed.stream;
            } else {
                recorded = new MediaStream(display.getVideoTracks());
            }
            for (const track of audio.tracks) recorded.addTrack(track);
            parts.recorded = recorded;

            const recorder = new MediaRecorder(recorded, { mimeType: type });
            parts.recorder = recorder;
            recorder.ondataavailable = (event) => {
                if (event.data.size === 0) return;
                parts.chunks.push(event.data);
                parts.bytes += event.data.size;
                // Stopped at the size limit as well as the time one: a screen
                // full of movement makes bytes far faster than a still one.
                if (parts.bytes > ceiling.current && recorder.state !== "inactive") {
                    parts.stopping = true;
                    setError("Stopped: the recording reached the size a message can carry");
                    recorder.stop();
                }
            };
            recorder.onstop = () => {
                const blob = new Blob(parts.chunks, { type });
                teardown();
                if (blob.size === 0) {
                    setStage("idle");
                    return;
                }
                const made = new File([blob], clipFileName(type), { type });
                setFile(made);
                setPreview(URL.createObjectURL(blob));
                setStage("ready");
            };

            // The person pressing the browser's own "stop sharing" means the same
            // thing as pressing stop here, and a recording that carried on
            // against a dead track would be a black rectangle.
            display.getVideoTracks()[0]?.addEventListener("ended", () => {
                if (!parts.stopping && recorder.state !== "inactive") {
                    parts.stopping = true;
                    recorder.stop();
                }
            });

            // A slice per second, so the size is known as it grows rather than
            // only at the end.
            recorder.start(1000);
            setSeconds(0);
            setStage("recording");
        },
        [teardown]
    );

    const pause = useCallback(() => {
        const recorder = kit.current.recorder;
        if (recorder?.state !== "recording") return;
        recorder.pause();
        setStage("paused");
    }, []);

    const resume = useCallback(() => {
        const recorder = kit.current.recorder;
        if (recorder?.state !== "paused") return;
        recorder.resume();
        setStage("recording");
    }, []);

    const discard = useCallback(() => {
        setPreview((current) => {
            if (current) URL.revokeObjectURL(current);
            return null;
        });
        setFile(null);
        setSeconds(0);
        setError("");
        setStage("idle");
    }, []);

    return {
        stage,
        seconds,
        file,
        preview,
        error,
        canvas,
        start,
        pause,
        resume,
        stop,
        discard
    };
}

/**
 * The screen with the camera drawn into the corner of it.
 *
 * Bottom left rather than bottom right: the right-hand corner is where a page
 * puts its own floating things, and a face over a chat bubble helps nobody.
 * Round, because a rectangle of somebody's room is what the camera sees and a
 * circle is what the person is.
 */
function compose(
    display: MediaStream,
    camera: MediaStream
): { canvas: HTMLCanvasElement; stream: MediaStream; frame: number } | null {
    const screenTrack = display.getVideoTracks()[0];
    if (!screenTrack) return null;
    const settings = screenTrack.getSettings();
    const width = Math.min(settings.width ?? MAX_WIDTH, MAX_WIDTH);
    const height = Math.round(width / ((settings.width ?? 16) / (settings.height ?? 9)));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;

    // Two video elements, off screen, feeding the canvas. They are never in the
    // document: a <video> only has to be playing to be drawn from.
    const screen = videoOf(display);
    const face = videoOf(camera);

    /** How big the face is, as a share of the picture's width. A fifth is what
     *  every client that does this settled on: recognisable, and not in the way
     *  of what is being shown. */
    const faceSize = Math.round(width * 0.2);
    const margin = Math.round(width * 0.02);

    let frame = 0;
    const draw = () => {
        frame = requestAnimationFrame(draw);
        if (screen.readyState >= 2) context.drawImage(screen, 0, 0, width, height);
        if (face.readyState >= 2) {
            const x = margin;
            const y = height - faceSize - margin;
            context.save();
            context.beginPath();
            context.arc(x + faceSize / 2, y + faceSize / 2, faceSize / 2, 0, Math.PI * 2);
            context.closePath();
            context.clip();
            // Cropped to a square before it is drawn round, so a 4:3 camera is
            // not squashed into the circle.
            const side = Math.min(face.videoWidth, face.videoHeight) || 1;
            context.drawImage(
                face,
                (face.videoWidth - side) / 2,
                (face.videoHeight - side) / 2,
                side,
                side,
                x,
                y,
                faceSize,
                faceSize
            );
            context.restore();
            context.beginPath();
            context.arc(x + faceSize / 2, y + faceSize / 2, faceSize / 2, 0, Math.PI * 2);
            context.strokeStyle = "rgba(255,255,255,0.85)";
            context.lineWidth = Math.max(2, Math.round(width * 0.003));
            context.stroke();
        }
    };
    frame = requestAnimationFrame(draw);

    return { canvas, stream: canvas.captureStream(FPS), frame };
}

/** A muted, playing video element for a stream. Muted because both of these are
 *  also being recorded: an unmuted one is the person's own voice coming back out
 *  of their speakers and into the microphone. */
function videoOf(stream: MediaStream): HTMLVideoElement {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    void video.play().catch(() => undefined);
    return video;
}

/**
 * The screen's sound and the microphone, as one track.
 *
 * Mixed rather than sent as two, for the same reason the picture is composed:
 * what leaves the browser has to play anywhere, and a file with two audio tracks
 * plays one of them - which one depending on the player.
 *
 * Nothing at all when there is neither, and no context is opened in that case:
 * an AudioContext that is created and never used still holds an audio device
 * open on some machines.
 */
function mixAudio(
    display: MediaStream,
    camera: MediaStream | null
): { context: AudioContext | null; tracks: MediaStreamTrack[] } {
    const sources = [display, camera].filter(
        (stream): stream is MediaStream => Boolean(stream) && stream!.getAudioTracks().length > 0
    );
    if (sources.length === 0) return { context: null, tracks: [] };
    // One source needs no mixing, and a mix of one is an AudioContext held open
    // for nothing.
    if (sources.length === 1) return { context: null, tracks: sources[0]!.getAudioTracks() };

    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    for (const stream of sources) {
        context.createMediaStreamSource(stream).connect(destination);
    }
    return { context, tracks: destination.stream.getAudioTracks() };
}
