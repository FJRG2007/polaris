"use client";

/**
 * The line that says nobody can hear you.
 *
 * The failure it exists for has no other symptom. A microphone that opened but
 * is picking nothing up - muted in the operating system, a headset switched off
 * at the cable, an interface on the wrong input - looks in Polaris exactly like
 * somebody who is not talking, and the person it is happening to has no reason
 * to suspect anything until somebody in the room says so.
 *
 * What counts as dead is decided in `no-audio`: only a device producing nothing
 * at all, or a voice going in with nothing coming out - never somebody who is
 * simply quiet. It can be closed, and it waits longer each time it comes back.
 */

import { AlertTriangle, X } from "lucide-react";
import { measureVoice } from "./voice-level";
import { useEffect, useState } from "react";
import { useVoiceSettings } from "./voice-settings";
import { dismissNoAudio, NO_AUDIO_START, watchNoAudio, type NoAudioWatch } from "./no-audio";

/** How often the level is read. */
const SAMPLE_MS = 500;

export function NoAudioNotice({
    track,
    device,
    micOn
}: {
    /** What is actually going out, or null when there is no microphone. */
    track: MediaStreamTrack | null;
    /** The microphone itself. The same object as `track` unless a noise filter
     *  sits between them. */
    device: MediaStreamTrack | null;
    /** Whether the reader wants to be heard. Muted is not a fault. */
    micOn: boolean;
}) {
    const [voice] = useVoiceSettings();
    const [watch, setWatch] = useState<NoAudioWatch>(NO_AUDIO_START);
    const source = device ?? track;

    // A different microphone starts with a clean slate, including a closed
    // warning: that was about the device before.
    useEffect(() => {
        setWatch(NO_AUDIO_START);
    }, [source]);

    useEffect(() => {
        if (!voice.noAudioWarning || !micOn || !track || !source) {
            setWatch((current) => (current.warning ? { ...current, warning: false } : current));
            return;
        }
        // Whatever was being timed stopped counting while the microphone was
        // off, so the clock starts again rather than resuming.
        setWatch((current) => ({
            ...current,
            flatSince: null,
            swallowedSince: null,
            swallowedHits: 0
        }));
        const heard = measureVoice(source);
        if (!heard) return;
        const sent = source === track ? heard : measureVoice(track);
        const timer = setInterval(() => {
            const devicePeak = heard.peak();
            setWatch((current) =>
                watchNoAudio(current, {
                    now: Date.now(),
                    sending: source.enabled && track.enabled,
                    device: devicePeak,
                    outgoing: sent ? (sent === heard ? devicePeak : sent.peak()) : devicePeak
                })
            );
        }, SAMPLE_MS);
        return () => {
            clearInterval(timer);
            heard.stop();
            if (sent !== heard) sent?.stop();
        };
    }, [voice.noAudioWarning, micOn, track, source]);

    if (!watch.warning) return null;
    return (
        <p
            role="status"
            className="flex shrink-0 items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-ink"
        >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
                Your microphone has not picked anything up for a while. Check that it is not muted
                on the machine itself, and that the right one is chosen under Account &gt; Devices.
            </span>
            <button
                type="button"
                onClick={() => setWatch(dismissNoAudio)}
                aria-label="Dismiss"
                title="Dismiss"
                className="-m-1 shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
            >
                <X className="size-3.5" />
            </button>
        </p>
    );
}
