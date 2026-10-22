"use client";

/**
 * The tab on a call doing what the person asked for from a deck key, and saying
 * where its controls are now so the key can show it.
 *
 * Held by the provider rather than by the call screen: the recorder and
 * hanging up are the provider's, and a call is still on when the person has
 * walked off to another screen - which is exactly when a key on the desk is
 * the control they reach for.
 *
 * Commands arrive on the call's own stream, addressed to this seat
 * (`lib/chat/call-remote`). Whether the person may record was decided by the
 * server before it sent one; this browser only adds whether it can.
 */

import { keepSeat } from "./call-seat";
import { useEffect, useRef } from "react";
import type { CallState } from "./call-state";
import { playClip } from "./soundboard-player";
import * as rules from "@/lib/chat/soundboard";
import type { CallRecording } from "./call-recorder";
import { onCallRemote, remoteStep } from "@/lib/chat/call-remote";

export function useCallRemote(
    meetingId: string | null,
    call: CallState,
    recording: CallRecording,
    leave: () => void
): void {
    // The newest of each, for a listener registered once per call.
    const latest = useRef({ call, recording, leave });
    latest.current = { call, recording, leave };

    useEffect(() => {
        if (!meetingId) return;
        return onCallRemote((command) => {
            const { call: now, recording: recorder, leave: hangUp } = latest.current;
            const step = remoteStep(command, {
                micOn: now.micOn,
                deafened: now.deafened,
                cameraOn: now.cameraOn,
                recording: recorder.running,
                canRecord: recorder.supported
            });
            if (step === "toggleMic") now.toggleMic();
            else if (step === "toggleDeafen") now.toggleDeafen();
            else if (step === "toggleCamera") now.toggleCamera();
            else if (step === "startRecording") recorder.start();
            else if (step === "stopRecording") recorder.stop();
            else if (step === "hangup") hangUp();
            else if (step === "sound" && command.command === "sound") {
                const played = command.played;
                void playClip(played.sound, {
                    url: played.url ?? null,
                    volume: rules.playbackVolume(played, { volume: 1, muted: new Set() }),
                    channel: played.from
                });
            }
        });
    }, [meetingId]);

    // The camera and the recorder, said when either moves, so a key shows the
    // change within a moment rather than at the next beat. The microphone,
    // headphones and screen are the call's own beat to say. Only by the seat
    // this tab is in: a browser another device took the call from has ended.
    const { cameraOn, participantId, ended } = call;
    const running = recording.running;
    useEffect(() => {
        if (!meetingId || !participantId || ended) return;
        const { micOn, deafened, sharing } = latest.current.call;
        void keepSeat(meetingId, {
            muted: !micOn || deafened,
            deafened,
            streaming: sharing,
            camera: cameraOn,
            recording: running
        }).catch(() => undefined);
    }, [meetingId, participantId, ended, cameraOn, running]);
}
