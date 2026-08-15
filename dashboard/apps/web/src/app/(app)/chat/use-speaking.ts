"use client";

/**
 * Who is talking.
 *
 * A row of faces with no indication of who is speaking is unreadable the moment
 * there are more than two: the sound comes out of one pair of speakers whichever
 * tile it belongs to, so with cameras off there is nothing at all to go on. This
 * measures each stream in the browser and reports the ones above a threshold, so
 * a ring can be drawn around them.
 *
 * Measured rather than signalled, deliberately. The alternative - each browser
 * telling the server it is talking, and the server telling everybody else - is a
 * message every few hundred milliseconds per person for something every listener
 * can work out from audio it already has, and it would be wrong by a round trip
 * besides.
 *
 * **The threshold is on volume, and it hangs on afterwards.** A gap between
 * words is a hundred milliseconds of near-silence, and a ring that flickered off
 * in every one of them would be worse than nothing. So the ring comes on at
 * once and goes off only after somebody has been quiet for a moment.
 */

import { useEffect, useRef, useState } from "react";

/** How often the streams are measured. Fast enough that the ring lands with the
 *  voice, slow enough that it is a rounding error next to decoding the audio. */
const SAMPLE_EVERY_MS = 100;

/** Root-mean-square above which somebody counts as speaking. Set by ear against
 *  a laptop microphone in a quiet room with the fan on: low enough to catch
 *  somebody talking normally, high enough that the room itself does not. */
const SPEAKING_RMS = 0.02;

/** How long the ring stays on after the level drops, so it does not flicker
 *  between words. */
const HANG_MS = 400;

interface Watched {
    readonly analyser: AnalyserNode;
    readonly source: MediaStreamAudioSourceNode;
    readonly samples: Float32Array;
    /** When this one was last loud. */
    lastLoud: number;
}

/**
 * The ids currently speaking, out of the streams handed in.
 *
 * @param streams - By the id the caller wants back: a participant id for a
 *   remote stream, and whatever it likes for its own.
 * @param enabled - False while there is no call, so nothing is measured and no
 *   audio context is made.
 */
export function useSpeaking(
    streams: ReadonlyMap<string, MediaStream | null>,
    enabled = true
): ReadonlySet<string> {
    const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set());
    const watched = useRef(new Map<string, Watched>());
    const context = useRef<AudioContext | null>(null);
    // Held in a ref so the sampling loop is not rebuilt every time a tile
    // appears - the map is a new object on every render of the call screen.
    const current = useRef(streams);
    current.current = streams;

    useEffect(() => {
        if (!enabled || typeof window === "undefined") return;
        const Ctor =
            window.AudioContext ??
            (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;

        const ctx = new Ctor();
        context.current = ctx;
        const mine = watched.current;

        const timer = setInterval(() => {
            const now = Date.now();
            const wanted = current.current;

            // Anything that has gone: a tile removed, or a stream replaced.
            for (const [id, entry] of mine) {
                if (wanted.has(id)) continue;
                entry.source.disconnect();
                mine.delete(id);
            }

            for (const [id, stream] of wanted) {
                if (mine.has(id) || !stream) continue;
                // A stream with no audio in it yet is not an error - the video
                // track can arrive first - it simply has nothing to measure.
                if (stream.getAudioTracks().length === 0) continue;
                try {
                    const analyser = ctx.createAnalyser();
                    // Small window: this is a level meter, not a spectrum.
                    analyser.fftSize = 512;
                    const source = ctx.createMediaStreamSource(stream);
                    source.connect(analyser);
                    mine.set(id, {
                        analyser,
                        source,
                        samples: new Float32Array(analyser.fftSize),
                        lastLoud: 0
                    });
                } catch {
                    // A stream the context will not take. Nothing to draw a ring
                    // from, and nothing worth telling anybody.
                }
            }

            const loud = new Set<string>();
            for (const [id, entry] of mine) {
                entry.analyser.getFloatTimeDomainData(entry.samples);
                let sum = 0;
                for (const sample of entry.samples) sum += sample * sample;
                if (Math.sqrt(sum / entry.samples.length) >= SPEAKING_RMS) entry.lastLoud = now;
                if (now - entry.lastLoud < HANG_MS) loud.add(id);
            }

            // Replaced only when the answer actually changed, so a call of eight
            // is not eight re-renders a second while everybody listens.
            setSpeaking((was) =>
                was.size === loud.size && [...loud].every((id) => was.has(id)) ? was : loud
            );
        }, SAMPLE_EVERY_MS);

        return () => {
            clearInterval(timer);
            for (const entry of mine.values()) entry.source.disconnect();
            mine.clear();
            void ctx.close().catch(() => undefined);
            context.current = null;
        };
    }, [enabled]);

    return speaking;
}
