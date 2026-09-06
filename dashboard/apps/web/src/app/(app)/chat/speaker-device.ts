"use client";

/**
 * Which output this browser plays a call through.
 *
 * The microphone, the camera and the screen each have a picker and the speakers
 * did not, which left the one device nobody can change from inside Polaris: a
 * headset plugged in after the tab was opened, a monitor whose speakers the
 * system happens to prefer, a call coming out of a laptop lid in a room with
 * other people in it. The answer was to leave the call, change it in the
 * operating system, and come back.
 *
 * Per browser, like the microphone and the volumes, and for the same reason: the
 * headset is plugged into this machine, not into an account.
 *
 * Not every browser can do it. `setSinkId` is Chromium and recent Safari; where
 * it is missing there is exactly one output as far as the page is concerned, so
 * the picker is not drawn at all rather than drawn and ignored.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.call.speaker";

/** Same-tab announcement, since the storage event only reaches other tabs. It is
 *  exported because every element already playing has to follow a change, not
 *  only the next one to start. */
export const SPEAKER_CHANGED = "polaris:call-speaker";
const CHANGED = SPEAKER_CHANGED;

/** Whether this browser can be told where to play. */
export function canChooseSpeaker(): boolean {
    return typeof window !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/** The one this browser has been told to use, or null for the system's own
 *  choice - which is what "Default" means and what most people want. */
export function speakerDevice(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(KEY) || null;
    } catch {
        return null;
    }
}

export function setSpeakerDevice(deviceId: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (deviceId) window.localStorage.setItem(KEY, deviceId);
        else window.localStorage.removeItem(KEY);
    } catch {
        // It still applies to what is playing now; it just will not be
        // remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/**
 * Play this element through the chosen output.
 *
 * Failures are swallowed on purpose, and there are two ordinary ones: a browser
 * without `setSinkId`, and a device that has been unplugged since it was chosen.
 * Neither is worth a message during a call - the sound keeps coming out of
 * wherever the system sends it, which is the same place it came out of before
 * anybody picked anything.
 */
export async function playThroughChosenSpeaker(element: HTMLMediaElement | null): Promise<void> {
    const chosen = speakerDevice();
    if (!element || !chosen || !canChooseSpeaker()) return;
    await (element as HTMLMediaElement & { setSinkId(id: string): Promise<void> })
        .setSinkId(chosen)
        .catch(() => undefined);
}

/** One output this browser can offer. */
export interface SpeakerDevice {
    readonly id: string;
    readonly label: string;
}

/**
 * The outputs on this machine, and which one is chosen.
 *
 * Names only exist once a microphone permission has been granted - the same rule
 * the input list lives under - so before a call this is a numbered list, and
 * becomes the real names as soon as somebody has been heard.
 */
export function useSpeakers(): {
    readonly devices: readonly SpeakerDevice[];
    readonly chosenId: string | null;
    readonly choose: (deviceId: string) => void;
} {
    const [devices, setDevices] = useState<readonly SpeakerDevice[]>([]);
    const [chosenId, setChosenId] = useState<string | null>(null);

    const look = useCallback(async () => {
        if (!canChooseSpeaker()) return;
        if (typeof navigator?.mediaDevices?.enumerateDevices !== "function") return;
        const found = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        setDevices(
            found
                .filter((device) => device.kind === "audiooutput" && device.deviceId)
                .map((device, index) => ({
                    id: device.deviceId,
                    // "default" is a real device id and the one most people are
                    // on; the browser's own label for it is usually good, and
                    // this is the fallback when it is empty.
                    label: device.label || (device.deviceId === "default" ? "System default" : `Output ${index + 1}`)
                }))
        );
    }, []);

    useEffect(() => {
        setChosenId(speakerDevice());
        void look();
        const onChosen = () => setChosenId(speakerDevice());
        window.addEventListener(CHANGED, onChosen);
        window.addEventListener("storage", onChosen);
        navigator.mediaDevices?.addEventListener?.("devicechange", look);
        return () => {
            window.removeEventListener(CHANGED, onChosen);
            window.removeEventListener("storage", onChosen);
            navigator.mediaDevices?.removeEventListener?.("devicechange", look);
        };
    }, [look]);

    const choose = useCallback((deviceId: string) => {
        setChosenId(deviceId);
        setSpeakerDevice(deviceId);
    }, []);

    return { devices, chosenId, choose };
}
