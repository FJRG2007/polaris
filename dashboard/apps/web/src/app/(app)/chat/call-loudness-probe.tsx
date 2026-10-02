"use client";

/**
 * Measures every voice in the call as it arrives here, and your own as it
 * leaves - see `call-loudness` for why and for what reads it.
 *
 * Draws nothing. One audio context for all of it, an analyser per voice and no
 * destination, so nothing measured here is ever played a second time. Mounted
 * beside the call's sound, which is what keeps a remote stream flowing: Chrome
 * gives Web Audio nothing from a WebRTC stream that no media element is playing.
 */

import { rmsDb } from "./mic-leveller";
import { useEffect, useRef } from "react";
import type { CallState } from "./use-call";
import { LOUDNESS_START, SELF, setLoudness, stepLoudness, type Loudness } from "./call-loudness";

/** How often each voice is read. Slow on purpose: this is a level over seconds,
 *  not a meter. */
const READ_EVERY_MS = 200;

interface Voice {
    /** The seat, which is what the speaker detection names. */
    readonly seat: string;
    /** What the level is kept under: the volume key. */
    readonly key: string;
    readonly track: MediaStreamTrack;
}

/**
 * The voices to measure. A diagnostic must never cost a call its sound, and this
 * renders inside the component that plays it - so a stream that is not what it
 * should be is a voice not measured, never a thrown render.
 */
function voicesOf(call: CallState): Voice[] {
    const voices: Voice[] = [];
    try {
        for (const person of call.meeting?.participants ?? []) {
            if (person.admission !== "admitted" || person.id === call.participantId) continue;
            const track = call.remote.get(person.id)?.getAudioTracks()[0];
            if (track) voices.push({ seat: person.id, key: person.userId ?? person.id, track });
        }
        if (call.outgoing && call.participantId) {
            voices.push({ seat: call.participantId, key: SELF, track: call.outgoing });
        }
    } catch {
        return [];
    }
    return voices;
}

export function CallLoudnessProbe({ call }: { call: CallState }) {
    // Read by the timer, so the graph is not rebuilt each time somebody starts or
    // stops talking.
    const speaking = useRef(call.speaking);
    speaking.current = call.speaking;

    const voices = voicesOf(call);
    const signature = voices.map((voice) => `${voice.key}=${voice.track.id}`).join(" ");
    const current = useRef(voices);
    current.current = voices;

    /** What has been learned, kept across rebuilds: somebody switching
     *  microphones has not stopped being the same voice. */
    const learned = useRef(new Map<string, Loudness>());

    useEffect(() => {
        const list = current.current;
        if (list.length === 0) return;
        const Context =
            typeof window === "undefined"
                ? undefined
                : (window.AudioContext ??
                  (window as unknown as { webkitAudioContext?: typeof AudioContext })
                      .webkitAudioContext);
        if (!Context) return;
        let context: AudioContext;
        try {
            context = new Context();
        } catch {
            return;
        }
        void context.resume().catch(() => undefined);

        const probes = list.flatMap((voice) => {
            try {
                const source = context.createMediaStreamSource(new MediaStream([voice.track]));
                const analyser = context.createAnalyser();
                analyser.fftSize = 2048;
                source.connect(analyser);
                return [{ voice, source, analyser, samples: new Float32Array(analyser.fftSize) }];
            } catch {
                return [];
            }
        });

        // Whoever has left takes their level with them.
        const keys = new Set(list.map((voice) => voice.key));
        for (const key of learned.current.keys()) if (!keys.has(key)) learned.current.delete(key);

        let last = Date.now();
        const timer = setInterval(() => {
            const now = Date.now();
            const elapsed = now - last;
            last = now;
            let changed = false;
            for (const probe of probes) {
                if (!speaking.current.has(probe.voice.seat)) continue;
                probe.analyser.getFloatTimeDomainData(probe.samples);
                const before = learned.current.get(probe.voice.key) ?? LOUDNESS_START;
                const after = stepLoudness(before, rmsDb(probe.samples), elapsed);
                if (after !== before) {
                    learned.current.set(probe.voice.key, after);
                    changed = true;
                }
            }
            if (changed) setLoudness(new Map(learned.current));
        }, READ_EVERY_MS);

        return () => {
            clearInterval(timer);
            for (const probe of probes) probe.source.disconnect();
            void context.close().catch(() => undefined);
        };
    }, [signature]);

    // Nothing measured outlives the call.
    useEffect(() => {
        const kept = learned.current;
        return () => {
            kept.clear();
            setLoudness(new Map());
        };
    }, []);

    return null;
}
