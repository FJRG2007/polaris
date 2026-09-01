"use client";

/**
 * The line that says nobody can hear you.
 *
 * The failure it exists for has no other symptom. A microphone that opened but
 * is picking nothing up - muted in the operating system, a headset switched off
 * at the cable, an interface on the wrong input - looks in Polaris exactly like
 * somebody who is not talking, and the person it is happening to has no reason
 * to suspect anything until somebody in the room says so. Which they eventually
 * do, several minutes in.
 *
 * So the level is watched while the microphone is on and unmuted, and after a
 * long enough stretch of nothing at all the call says so. Long enough matters in
 * both directions: too short and it accuses everybody who is listening, too long
 * and it arrives after the meeting.
 *
 * Only silence counts, not quiet. The threshold is far below anything a voice
 * activity gate would use, because the claim being made is "this device is
 * producing nothing", not "you are quiet" - and being told you are quiet when
 * you are simply not talking is the version of this that gets switched off.
 */

import { AlertTriangle } from "lucide-react";
import { measureVoice } from "./voice-level";
import { useEffect, useRef, useState } from "react";
import { useVoiceSettings } from "./voice-settings";

/** How long a microphone has to produce nothing at all before it is worth
 *  saying. Long enough to sit through a paragraph of somebody else talking. */
const QUIET_MS = 45_000;

/** Below this is silence rather than quiet: a room with a fan in it reads
 *  above it, and a device producing nothing reads zero. */
const FLOOR = 2;

export function NoAudioNotice({
    track,
    micOn
}: {
    /** What is actually going out, or null when there is no microphone. */
    track: MediaStreamTrack | null;
    /** Whether the reader wants to be heard. Muted is not a fault. */
    micOn: boolean;
}) {
    const [voice] = useVoiceSettings();
    const [quiet, setQuiet] = useState(false);
    // Reset by every sound, so one word anywhere in the window clears it.
    const since = useRef(Date.now());

    useEffect(() => {
        if (!voice.noAudioWarning || !micOn || !track) {
            setQuiet(false);
            return;
        }
        const meter = measureVoice(track);
        if (!meter) return;
        since.current = Date.now();
        const timer = setInterval(() => {
            if (meter.read() > FLOOR) {
                since.current = Date.now();
                setQuiet(false);
                return;
            }
            setQuiet(Date.now() - since.current > QUIET_MS);
        }, 1000);
        return () => {
            clearInterval(timer);
            meter.stop();
            setQuiet(false);
        };
    }, [voice.noAudioWarning, micOn, track]);

    if (!quiet) return null;
    return (
        <p
            role="status"
            className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning"
        >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
                Your microphone has not picked anything up for a while. Check that it is not muted on
                the machine itself, and that the right one is chosen under Account &gt; Devices.
            </span>
        </p>
    );
}
