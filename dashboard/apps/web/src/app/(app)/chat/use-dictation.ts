"use client";

/**
 * Speech typed into the composer as it is said.
 *
 * Two engines. The browser's own recognizer gives live words - interim text as
 * it guesses, final text once it is sure - and is the default where it exists.
 * Source: MDN, Web API "SpeechRecognition" (limited availability, prefixed
 * `webkitSpeechRecognition` in Chromium and Safari, absent in Firefox; Chrome's
 * engine is server-based and fails with `network` offline).
 *
 * The private engine records the microphone through the same constraints a voice
 * message uses (`micConstraints`) and sends each stretch of speech to Polaris's
 * own transcription at the pause that ends it. Nothing is stored; a chunk is a
 * complete recording of its own, so it is readable on its own.
 *
 * Either way the text is handed to the caller and never sent: the person reads
 * it, fixes it and presses Send. Stopping releases the microphone fully - every
 * track stopped, the meter's audio context closed.
 */

import { measureVoice } from "./voice-level";
import { micConstraints } from "./mic-cleanup";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_VOICE_SECONDS, recordingType } from "./voice-recorder";
import { transcribeAudio } from "@/lib/polar/transcribe-audio";
import {
    browserProblem,
    chunkReady,
    privateProblem,
    speechLang,
    type DictationEngine,
    type DictationProblem
} from "./dictation-logic";

/** The part of the recognizer this uses, since not every DOM library types it. */
interface Recognizer {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    onresult: ((event: RecognizerResultEvent) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    onsoundstart: (() => void) | null;
    onsoundend: (() => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
}

interface RecognizerResultEvent {
    resultIndex: number;
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognizerConstructor = new () => Recognizer;

/** The browser's recognizer, prefixed or not, or null where there is none. */
export function speechRecognizer(): RecognizerConstructor | null {
    if (typeof window === "undefined") return null;
    const found = window as unknown as {
        SpeechRecognition?: RecognizerConstructor;
        webkitSpeechRecognition?: RecognizerConstructor;
    };
    return found.SpeechRecognition ?? found.webkitSpeechRecognition ?? null;
}

/** A level above this, on the meter's 0-100 scale, is somebody talking. */
const SPEECH_LEVEL = 14;
const TICK_MS = 100;

/** Restarts the browser recognizer may make on its own in a row before it is
 *  given up on - a phone ends recognition after every phrase, and a recognizer
 *  that ends at once every time is one that is not going to work. */
const QUICK_RESTARTS = 3;

export interface Dictation {
    readonly active: boolean;
    /** Words the browser is still guessing at, shown greyed until final. */
    readonly interim: string;
    /** 0 to 100 for the private engine; 0 or 60 for the browser one, which only
     *  says whether it hears sound. */
    readonly level: number;
    /** Chunks sent to Polaris and not yet back. */
    readonly transcribing: boolean;
    readonly problem: DictationProblem | null;
    readonly start: () => void;
    readonly stop: () => void;
    /** Ends dictation and drops whatever it has not handed over yet - for a box
     *  that was emptied or now belongs to another conversation. */
    readonly cancel: () => void;
    readonly clearProblem: () => void;
}

export function useDictation(options: {
    engine: DictationEngine | null;
    locale: string;
    /** Text that is final, to be put in at the caret. */
    onText: (text: string) => void;
}): Dictation {
    const [active, setActive] = useState(false);
    const [interim, setInterim] = useState("");
    const [level, setLevel] = useState(0);
    const [pending, setPending] = useState(0);
    const [problem, setProblem] = useState<DictationProblem | null>(null);

    const latest = useRef(options);
    latest.current = options;
    /** Whatever ends the session that is running, or null. */
    const ending = useRef<(() => void) | null>(null);
    /** Each session's way of dropping what it has still to hand over, kept
     *  past a stop since a stopped session may still deliver its last words. */
    const leftovers = useRef(new Set<() => void>());

    const stop = useCallback(() => {
        const end = ending.current;
        ending.current = null;
        end?.();
        setActive(false);
        setInterim("");
        setLevel(0);
    }, []);

    const fail = useCallback(
        (next: DictationProblem | null) => {
            if (next) setProblem(next);
            stop();
        },
        [stop]
    );

    const startBrowser = useCallback(() => {
        const Constructor = speechRecognizer();
        if (!Constructor) return fail("failed");
        let wanted = true;
        let quick = 0;
        let silent = 0;
        let startedAt = 0;
        let dropped = false;
        let recognizer: Recognizer;
        const open = () => {
            recognizer = new Constructor();
            recognizer.lang = speechLang(latest.current.locale);
            recognizer.continuous = true;
            recognizer.interimResults = true;
            recognizer.maxAlternatives = 1;
            recognizer.onresult = (event) => {
                if (dropped) return;
                let guess = "";
                for (let at = event.resultIndex; at < event.results.length; at++) {
                    const result = event.results[at]!;
                    const text = result[0].transcript;
                    if (result.isFinal) {
                        const said = text.trim();
                        if (said) latest.current.onText(said);
                    } else {
                        guess += text;
                    }
                }
                setInterim(guess.trim());
                quick = 0;
                silent = 0;
            };
            recognizer.onsoundstart = () => setLevel(60);
            recognizer.onsoundend = () => setLevel(0);
            recognizer.onerror = (event) => {
                if (!wanted) return;
                // "no-speech" ends a quiet stretch, and listening goes on after
                // it - twice in a row with nothing said is somebody who has
                // stopped talking.
                if (event.error === "no-speech" && ++silent < 2) return;
                wanted = false;
                fail(browserProblem(event.error));
            };
            recognizer.onend = () => {
                setInterim("");
                if (!wanted) return;
                // Ended by itself: a phone does after each phrase. Listening
                // again keeps one tap one session.
                quick = Date.now() - startedAt < 1000 ? quick + 1 : 0;
                if (quick >= QUICK_RESTARTS) {
                    wanted = false;
                    return fail("noSpeech");
                }
                try {
                    open();
                } catch {
                    wanted = false;
                    fail("failed");
                }
            };
            startedAt = Date.now();
            recognizer.start();
        };
        try {
            open();
        } catch {
            return fail("failed");
        }
        setActive(true);
        ending.current = () => {
            wanted = false;
            try {
                // `stop` hands back what was heard so far as a final result.
                recognizer.stop();
            } catch {
                // Already ended.
            }
        };
        leftovers.current.add(() => {
            dropped = true;
            wanted = false;
            try {
                recognizer.abort();
            } catch {
                // Already ended.
            }
        });
    }, [fail]);

    const startPrivate = useCallback(() => {
        const type = recordingType();
        if (!type || typeof navigator?.mediaDevices?.getUserMedia !== "function") {
            return fail("failed");
        }
        let stopped = false;
        let stream: MediaStream | null = null;
        let meter: ReturnType<typeof measureVoice> = null;
        let ticker: ReturnType<typeof setInterval> | null = null;
        let recorder: MediaRecorder | null = null;
        const abort = new AbortController();
        /** One request at a time, so chunks land in the order they were said. */
        let queue: Promise<void> = Promise.resolve();

        const send = (blob: Blob, durationMs: number) => {
            setPending((count) => count + 1);
            queue = queue.then(async () => {
                let heard: { text: string } | { error: string };
                try {
                    heard = await transcribeAudio(blob, durationMs, null, abort.signal);
                } catch {
                    heard = { error: "transcribe_failed" };
                } finally {
                    setPending((count) => count - 1);
                }
                if (abort.signal.aborted) return;
                if ("error" in heard) {
                    const problem = privateProblem(heard.error);
                    // A refusal that the next chunk would meet too ends the
                    // session rather than leaving the microphone posting into it.
                    if (problem !== "failed" && !stopped) fail(problem);
                    else setProblem(problem);
                    return;
                }
                const said = heard.text.trim();
                if (said) latest.current.onText(said);
            });
        };

        /** A fresh recorder for the next stretch; the one before is stopped
         *  and its recording sent if anybody spoke in it. */
        let chunkStart = 0;
        let heard = false;
        let lastLoud = 0;
        const record = (live: MediaStream) => {
            const next = new MediaRecorder(live, { mimeType: type });
            const parts: Blob[] = [];
            const began = Date.now();
            const spoke = { value: false };
            next.ondataavailable = (event) => {
                if (event.data.size > 0) parts.push(event.data);
            };
            next.onstop = () => {
                if (spoke.value && parts.length > 0) {
                    send(new Blob(parts, { type }), Date.now() - began);
                }
            };
            next.start();
            recorder = next;
            chunkStart = began;
            heard = false;
            return spoke;
        };

        const release = () => {
            stopped = true;
            if (ticker) clearInterval(ticker);
            ticker = null;
            if (recorder?.state === "recording") recorder.stop();
            recorder = null;
            meter?.stop();
            meter = null;
            for (const track of stream?.getTracks() ?? []) track.stop();
            stream = null;
        };

        setActive(true);
        ending.current = release;

        void navigator.mediaDevices
            .getUserMedia({ audio: micConstraints() })
            .then((live) => {
                if (stopped) {
                    for (const track of live.getTracks()) track.stop();
                    return;
                }
                stream = live;
                const track = live.getAudioTracks()[0];
                meter = track ? measureVoice(track) : null;
                let spoke = record(live);
                const began = Date.now();
                ticker = setInterval(() => {
                    const now = Date.now();
                    const loudness = meter?.read() ?? 0;
                    setLevel(loudness);
                    if (loudness >= SPEECH_LEVEL) {
                        heard = true;
                        spoke.value = true;
                        lastLoud = now;
                    }
                    if (now - began >= MAX_VOICE_SECONDS * 1000) {
                        stop();
                        return;
                    }
                    if (chunkReady({ heard, quietMs: now - lastLoud, chunkMs: now - chunkStart })) {
                        recorder?.stop();
                        spoke = record(live);
                    }
                }, TICK_MS);
            })
            .catch((error: unknown) => {
                if (!stopped) fail(micProblem(error));
            });

        // Leaving the conversation drops what is still on its way; a stop the
        // person asked for lets the last chunk through.
        leftovers.current.add(() => {
            abort.abort();
            release();
        });
    }, [fail, stop]);

    const start = useCallback(() => {
        if (ending.current) return;
        setProblem(null);
        const engine = latest.current.engine;
        if (engine === "browser") startBrowser();
        else if (engine === "private") startPrivate();
    }, [startBrowser, startPrivate]);

    const dropLeftovers = useCallback(() => {
        const drops = [...leftovers.current];
        leftovers.current.clear();
        for (const drop of drops) drop();
    }, []);

    const cancel = useCallback(() => {
        ending.current = null;
        dropLeftovers();
        stop();
    }, [dropLeftovers, stop]);

    // Gone with the box: a conversation left, a route changed.
    useEffect(
        () => () => {
            ending.current = null;
            dropLeftovers();
        },
        [dropLeftovers]
    );

    // A hidden tab is not somebody dictating, and a live microphone behind
    // another app is the kind of thing nobody forgives.
    useEffect(() => {
        if (!active) return;
        const onHide = () => {
            if (document.visibilityState === "hidden") stop();
        };
        document.addEventListener("visibilitychange", onHide);
        window.addEventListener("pagehide", stop);
        return () => {
            document.removeEventListener("visibilitychange", onHide);
            window.removeEventListener("pagehide", stop);
        };
    }, [active, stop]);

    const clearProblem = useCallback(() => setProblem(null), []);

    return {
        active,
        interim,
        level,
        transcribing: pending > 0,
        problem,
        start,
        stop,
        cancel,
        clearProblem
    };
}

/** A refused microphone as a problem: a missing or busy device is not one the
 *  site settings can fix. */
function micProblem(error: unknown): DictationProblem {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError") {
        return "noMic";
    }
    if (name === "NotAllowedError" || name === "SecurityError") return "micBlocked";
    return "failed";
}

/** How long one answer about private dictation is trusted in this tab. */
const PRIVATE_TTL_MS = 5 * 60_000;
let privateAnswer: { at: number; value: Promise<boolean> } | null = null;

/** Whether Polaris can transcribe for this person, asked once per tab and only
 *  when it matters. A failed question is a no: the mic falls back rather than
 *  offering an engine that may not answer. */
function askPrivateDictation(): Promise<boolean> {
    if (privateAnswer && Date.now() - privateAnswer.at < PRIVATE_TTL_MS) return privateAnswer.value;
    const value = fetch("/api/polar/transcribe", { headers: { Accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: unknown) => (data as { available?: unknown } | null)?.available === true)
        .catch(() => false);
    privateAnswer = { at: Date.now(), value };
    return value;
}

/** Private dictation's availability, asked only while `wanted`. */
export function usePrivateDictation(wanted: boolean): boolean {
    const [available, setAvailable] = useState(false);
    useEffect(() => {
        if (!wanted) return;
        let live = true;
        void askPrivateDictation().then((value) => {
            if (live) setAvailable(value);
        });
        return () => {
            live = false;
        };
    }, [wanted]);
    return available;
}
