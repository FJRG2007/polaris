"use client";

/**
 * Recording a voice message.
 *
 * Some things are faster said than typed, and a conversation that can carry a
 * screenshot but not ten seconds of speech is missing the shorter half of what
 * people send each other.
 *
 * A recording is an ordinary attachment - the same upload, the same storage
 * target, the same limits and the same delete - because it is one. Nothing here
 * writes a new path for bytes; what is new is the microphone at one end and the
 * player at the other.
 *
 * The microphone is opened with the same constraints a call uses, so somebody
 * who has turned the browser's cleanup off for calls is not quietly given it
 * back here.
 */

import { micConstraints } from "./mic-cleanup";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long one may run.
 *
 * Not a limit on what anybody has to say: a recording is held whole in memory in
 * the browser, posted whole, and held whole again on the way into storage, and
 * the attachment ceiling is what it would hit next anyway. Five minutes of Opus
 * is a couple of megabytes.
 */
export const MAX_VOICE_SECONDS = 300;

/** The containers a browser will actually record into, best first. Opus in WebM
 *  is what Chrome and Firefox give; Safari records MP4 and nothing else. */
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** What this browser can record, or null when it cannot record at all. */
export function recordingType(): string | null {
    if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
    return TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/** Whether this browser can be asked at all. Used to decide whether the button
 *  exists, rather than offering one that fails when pressed. */
export function canRecord(): boolean {
    return recordingType() !== null && typeof navigator?.mediaDevices?.getUserMedia === "function";
}

/** The name the recording is sent under. Plain and the same every time: the
 *  message says when it was said, and a name with a timestamp in it says it
 *  again, differently. */
export function voiceFileName(type: string): string {
    const container = type.split(";")[0]?.trim() ?? "";
    const extension =
        container === "audio/mp4" ? "m4a" : container === "audio/ogg" ? "ogg" : "webm";
    return `voice-message.${extension}`;
}

/** Whether an attachment is something to play rather than to download. */
export function isPlayable(contentType: string): boolean {
    return contentType.toLowerCase().startsWith("audio/");
}

/** Whether an attachment is one of these recordings, as opposed to a music file
 *  somebody uploaded - which gets the same player but keeps its name. */
export function isVoiceMessage(name: string, contentType: string): boolean {
    return isPlayable(contentType) && /^voice-message\.[a-z0-9]+$/i.test(name);
}

/** Seconds as a clock reads them. */
export function spokenLength(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** How many bars a recording is drawn as. Enough to read as speech and few
 *  enough to fit beside a play button on a phone. */
export const WAVEFORM_BARS = 48;

/** The most bars that may be stored, which is what the server allows. */
const MAX_BARS = 64;

/** How often the microphone is measured. Also the resolution of the shape: ten
 *  samples a second is more than a bar an eighth of a second wide needs. */
const METER_EVERY_MS = 100;

/** Under this, nothing is being heard. A live microphone in a quiet room still
 *  reads a thousandth or two; a muted one reads exactly nothing. */
const SILENCE = 0.008;

/** How long silence has to last before it is worth saying so. Long enough that
 *  a pause between sentences is not an alarm. */
const SILENT_AFTER_MS = 2500;

/**
 * The shape of a recording, one digit a bar.
 *
 * Levels are the loudest moment in each slice rather than the average, because a
 * waveform is read as "where did they speak", and an average of speech and the
 * gaps around it is a flat line. Then the whole thing is scaled against its own
 * loudest bar - somebody who recorded quietly gets a shape rather than a hyphen.
 */
export function barsFrom(levels: readonly number[], bars: number = WAVEFORM_BARS): string {
    const wanted = Math.max(1, Math.min(Math.round(bars), MAX_BARS));
    if (levels.length === 0) return "0".repeat(wanted);

    const loudest: number[] = [];
    for (let bar = 0; bar < wanted; bar += 1) {
        const from = Math.floor((bar * levels.length) / wanted);
        const to = Math.max(from + 1, Math.floor(((bar + 1) * levels.length) / wanted));
        let peak = 0;
        for (let at = from; at < to && at < levels.length; at += 1) {
            peak = Math.max(peak, levels[at] ?? 0);
        }
        loudest.push(peak);
    }

    const top = Math.max(...loudest);
    if (top <= 0) return "0".repeat(wanted);
    return loudest
        .map((level) => String(Math.min(9, Math.max(0, Math.round((level / top) * 9)))))
        .join("");
}

/** A stored waveform read back as numbers, for drawing. */
export function barsOf(waveform: string | null | undefined): number[] {
    if (!waveform) return [];
    return [...waveform].map((digit) => Number(digit) || 0);
}

/** What the browser measured while recording, sent alongside the file. */
export interface RecordedSound {
    readonly durationMs: number;
    readonly waveform: string;
}

/**
 * The quietest recording that still fills the meter.
 *
 * The live bars are scaled against the loudest moment so far, the same way the
 * stored shape is scaled against the loudest moment of the whole recording -
 * which is why the two used to disagree so badly: the meter drew raw loudness,
 * where ordinary speech is a tenth of the way up, and then the message came back
 * with a full waveform on it.
 *
 * Without a floor the scaling would make a silent room look like shouting: the
 * loudest hiss so far becomes the top of the meter. This is roughly the level of
 * quiet speech, so anything below it stays visibly small.
 */
const QUIET_PEAK = 0.05;

export interface VoiceRecording {
    /** True from the moment the microphone opens. */
    readonly recording: boolean;
    /** How long it has been running, in whole seconds. */
    readonly seconds: number;
    /** The last couple of seconds of level, newest last, for the meter that moves
     *  while somebody talks. Already scaled against the loudest moment so far, so
     *  a bar is a fraction between nothing and full - the same scale the waveform
     *  on the sent message uses. */
    readonly levels: readonly number[];
    /** True when nothing has been heard for a while - a muted microphone, the
     *  wrong device, a headset that is not the one selected. Said out loud
     *  rather than left to be discovered when the message is played back. */
    readonly silent: boolean;
    /** What went wrong, in the words somebody can act on. */
    readonly error: string | null;
    readonly start: () => void;
    /** Stop and hand the file over. */
    readonly stop: () => void;
    /** Stop and throw it away. */
    readonly cancel: () => void;
}

/**
 * The recorder, as a piece of state.
 *
 * Everything it opens it closes: the microphone light going off when a recording
 * is cancelled is the whole reason the tracks are stopped in one place rather
 * than at each of the three exits. Leaving the room - a navigation, a closed
 * conversation - is one of those exits, which is what the effect is for.
 */
export function useVoiceRecording(
    onRecorded: (file: File, sound: RecordedSound) => void
): VoiceRecording {
    const [recording, setRecording] = useState(false);
    const [seconds, setSeconds] = useState(0);
    const [levels, setLevels] = useState<readonly number[]>([]);
    const [silent, setSilent] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const recorder = useRef<MediaRecorder | null>(null);
    const chunks = useRef<Blob[]>([]);
    const keep = useRef(true);
    const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
    const began = useRef(0);
    const measured = useRef<number[]>([]);
    /** The loudest moment so far, which is what the meter is drawn against. */
    const loudest = useRef(0);
    const listener = useRef<AudioContext | null>(null);
    const done = useRef(onRecorded);
    done.current = onRecorded;

    const release = useCallback(() => {
        if (ticker.current) clearInterval(ticker.current);
        ticker.current = null;
        for (const track of recorder.current?.stream.getTracks() ?? []) track.stop();
        recorder.current = null;
        // The graph goes with the microphone. A context left open holds the
        // audio hardware awake for a conversation nobody is recording in.
        void listener.current?.close().catch(() => undefined);
        listener.current = null;
        setRecording(false);
        setSeconds(0);
        setLevels([]);
        setSilent(false);
    }, []);

    const start = useCallback(() => {
        const type = recordingType();
        if (!type) {
            setError("This browser cannot record audio.");
            return;
        }
        setError(null);

        void navigator.mediaDevices
            .getUserMedia({ audio: micConstraints() })
            .then((stream) => {
                const media = new MediaRecorder(stream, { mimeType: type });
                recorder.current = media;
                chunks.current = [];
                keep.current = true;

                media.ondataavailable = (event) => {
                    if (event.data.size > 0) chunks.current.push(event.data);
                };
                media.onstop = () => {
                    const parts = chunks.current;
                    chunks.current = [];
                    const wanted = keep.current;
                    // Measured here rather than read off the file. A stream
                    // recorded in a browser carries no duration in its
                    // container - which is why a seven-second message played
                    // back as 0:00 - and the clock that ran while it recorded is
                    // the one place the answer exists without downloading the
                    // whole thing to find out.
                    const sound = {
                        durationMs: Math.max(0, Date.now() - began.current),
                        waveform: barsFrom(measured.current)
                    };
                    release();
                    if (!wanted || parts.length === 0) return;
                    const blob = new Blob(parts, { type });
                    done.current(new File([blob], voiceFileName(type), { type }), sound);
                };

                // The same microphone, listened to as well as recorded. Nothing
                // is connected to the speakers: this graph ends at the analyser,
                // or somebody would hear themselves half a second late.
                const listening = new AudioContext();
                listener.current = listening;
                void listening.resume().catch(() => undefined);
                const analyser = listening.createAnalyser();
                analyser.fftSize = 1024;
                analyser.smoothingTimeConstant = 0.2;
                listening.createMediaStreamSource(stream).connect(analyser);
                const frame = new Uint8Array(analyser.fftSize);

                media.start();
                setRecording(true);
                setSeconds(0);
                setLevels([]);
                setSilent(false);
                measured.current = [];
                loudest.current = 0;
                began.current = Date.now();
                let lastHeard = Date.now();

                ticker.current = setInterval(() => {
                    analyser.getByteTimeDomainData(frame);
                    let square = 0;
                    for (const sample of frame) {
                        const value = (sample - 128) / 128;
                        square += value * value;
                    }
                    const level = Math.sqrt(square / frame.length);
                    // The measurement is what is stored; the meter shows it
                    // against the loudest moment so far. Speech is a tenth of the
                    // way up in absolute terms, so drawing it raw made a
                    // perfectly good recording look like it was hearing nothing.
                    measured.current.push(level);
                    loudest.current = Math.max(loudest.current, level);
                    const shown = Math.min(1, level / Math.max(loudest.current, QUIET_PEAK));
                    setLevels((current) => [...current, shown].slice(-WAVEFORM_BARS));

                    const now = Date.now();
                    if (level > SILENCE) lastHeard = now;
                    setSilent(now - lastHeard > SILENT_AFTER_MS);
                    setSeconds(Math.floor((now - began.current) / 1000));

                    // The ceiling ends the recording rather than dropping it:
                    // somebody who has talked for five minutes should get the
                    // five minutes, not an apology.
                    if (now - began.current >= MAX_VOICE_SECONDS * 1000) media.stop();
                }, METER_EVERY_MS);
            })
            .catch(() => {
                setError("Polaris could not reach your microphone.");
            });
    }, [release]);

    const stop = useCallback(() => {
        keep.current = true;
        if (recorder.current?.state === "recording") recorder.current.stop();
        else release();
    }, [release]);

    const cancel = useCallback(() => {
        keep.current = false;
        if (recorder.current?.state === "recording") recorder.current.stop();
        else release();
    }, [release]);

    useEffect(() => {
        return () => {
            keep.current = false;
            if (recorder.current?.state === "recording") recorder.current.stop();
            release();
        };
    }, [release]);

    return { recording, seconds, levels, silent, error, start, stop, cancel };
}
