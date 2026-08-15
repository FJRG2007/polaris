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

export interface VoiceRecording {
    /** True from the moment the microphone opens. */
    readonly recording: boolean;
    /** How long it has been running, in whole seconds. */
    readonly seconds: number;
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
export function useVoiceRecording(onRecorded: (file: File) => void): VoiceRecording {
    const [recording, setRecording] = useState(false);
    const [seconds, setSeconds] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const recorder = useRef<MediaRecorder | null>(null);
    const chunks = useRef<Blob[]>([]);
    const keep = useRef(true);
    const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
    const done = useRef(onRecorded);
    done.current = onRecorded;

    const release = useCallback(() => {
        if (ticker.current) clearInterval(ticker.current);
        ticker.current = null;
        for (const track of recorder.current?.stream.getTracks() ?? []) track.stop();
        recorder.current = null;
        setRecording(false);
        setSeconds(0);
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
                    release();
                    if (!wanted || parts.length === 0) return;
                    const blob = new Blob(parts, { type });
                    done.current(new File([blob], voiceFileName(type), { type }));
                };

                media.start();
                setRecording(true);
                setSeconds(0);
                const began = Date.now();
                ticker.current = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - began) / 1000);
                    setSeconds(elapsed);
                    // The ceiling ends the recording rather than dropping it:
                    // somebody who has talked for five minutes should get the
                    // five minutes, not an apology.
                    if (elapsed >= MAX_VOICE_SECONDS) media.stop();
                }, 250);
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

    return { recording, seconds, error, start, stop, cancel };
}
