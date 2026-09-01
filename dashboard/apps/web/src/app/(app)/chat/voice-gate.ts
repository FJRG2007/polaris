"use client";

/**
 * What decides, moment to moment, whether this browser is sending.
 *
 * Three answers, and only one of them is new behaviour anybody gets without
 * asking. `open` is what Polaris has always done - the track is live until
 * somebody presses mute - and it is the default; the other two are somebody
 * choosing on the settings screen.
 *
 * Both of the others are the same shape: something decides "speaking now", and
 * the microphone follows it. They are here together for that reason, and because
 * they must never both be running - a key held while a threshold disagrees is a
 * microphone being opened and closed by two things at once.
 *
 * The gate never argues with the mute button. Mute is a person saying they do
 * not want to be heard, and a threshold that reopened the microphone on the next
 * word would be the product overruling them; so the gate is only consulted while
 * the microphone is on.
 *
 * The key is a `KeyboardEvent.code` and is listened for on the window, so it
 * works wherever the reader is in Polaris - a call outlives the screen that
 * started it. It stands down while something else owns the keyboard: holding
 * space to talk must not also put spaces in the message somebody is typing.
 */

import { useEffect, useRef } from "react";
import { keyboardIsBusy } from "@/lib/keyboard";
import { measureVoice, speaking } from "./voice-level";
import { voiceSettings, type VoiceSettings } from "./voice-settings";

/** How often the level is read while voice activity is on. Fast enough to open
 *  on the first syllable, slow enough that it is not a frame loop. */
const SAMPLE_MS = 60;

export function useVoiceGate({
    micOn,
    track,
    setSending
}: {
    /** Whether the microphone is on at all. False is somebody having muted
     *  themselves, and the gate has nothing to say about that. */
    micOn: boolean;
    /**
     * What to listen to for voice activity, or null when there is no call.
     *
     * The caller decides which track that is: the cleaned-up one when the reader
     * asked for the better detection, the raw device otherwise - see
     * `advancedActivity`.
     */
    track: MediaStreamTrack | null;
    /** Open or close the microphone. The same function the mute button uses, so
     *  everybody else is told either way. */
    setSending: (on: boolean) => void;
}): void {
    // Held in a ref so the effect below is bound once per call rather than on
    // every render of whatever is drawing it.
    const send = useRef(setSending);
    send.current = setSending;

    // Read when the gate starts rather than followed: changing the mode while a
    // key is held would leave the microphone in whichever state that moment
    // caught it in. The settings screen is not somewhere anybody is mid-call.
    const settings = useRef<VoiceSettings>(voiceSettings());

    useEffect(() => {
        settings.current = voiceSettings();
        const mode = settings.current.inputMode;
        if (!micOn || mode === "open") return;

        // Closed the moment the gate takes over, so nothing is sent until
        // something opens it. The other way round - open until proven quiet -
        // is a room hearing whatever was happening when somebody joined.
        send.current(false);

        if (mode === "ptt") {
            const key = settings.current.pttKey;
            const release = settings.current.pttReleaseMs;
            let closing: ReturnType<typeof setTimeout> | null = null;
            let held = false;

            const open = () => {
                if (closing) {
                    clearTimeout(closing);
                    closing = null;
                }
                if (held) return;
                held = true;
                send.current(true);
            };
            const close = () => {
                if (!held) return;
                held = false;
                // A moment after the key, because zero cuts the last syllable
                // off and everybody hears it.
                closing = setTimeout(() => {
                    closing = null;
                    send.current(false);
                }, release);
            };

            const down = (event: KeyboardEvent) => {
                if (event.code !== key || event.repeat) return;
                // Not while a field, a dialog or a menu owns the keyboard:
                // holding space to talk must not also type spaces.
                if (keyboardIsBusy(event)) return;
                event.preventDefault();
                open();
            };
            const up = (event: KeyboardEvent) => {
                if (event.code !== key) return;
                close();
            };
            // Letting go outside the window never fires a keyup, so a key held
            // while switching applications would leave the microphone open.
            const blur = () => close();

            window.addEventListener("keydown", down);
            window.addEventListener("keyup", up);
            window.addEventListener("blur", blur);
            return () => {
                if (closing) clearTimeout(closing);
                window.removeEventListener("keydown", down);
                window.removeEventListener("keyup", up);
                window.removeEventListener("blur", blur);
                send.current(true);
            };
        }

        if (!track) return;
        const meter = measureVoice(track);
        if (!meter) {
            // No Web Audio: the honest answer is to leave the microphone open
            // rather than to gate it on a measurement that does not exist.
            send.current(true);
            return;
        }

        let open = false;
        let closing: ReturnType<typeof setTimeout> | null = null;
        const threshold = settings.current.activityThreshold;
        const release = Math.max(settings.current.pttReleaseMs, 200);

        const timer = setInterval(() => {
            const loud = speaking(meter.read(), threshold, open);
            if (loud) {
                if (closing) {
                    clearTimeout(closing);
                    closing = null;
                }
                if (!open) {
                    open = true;
                    send.current(true);
                }
                return;
            }
            if (!open || closing) return;
            // The same tail the key gets, and for the same reason: closing on
            // the first quiet sample cuts the end off every sentence.
            closing = setTimeout(() => {
                closing = null;
                open = false;
                send.current(false);
            }, release);
        }, SAMPLE_MS);

        return () => {
            clearInterval(timer);
            if (closing) clearTimeout(closing);
            meter.stop();
            send.current(true);
        };
    }, [micOn, track]);
}
