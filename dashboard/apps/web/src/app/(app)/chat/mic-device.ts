"use client";

/**
 * Which microphone this browser uses.
 *
 * A fact about a room rather than about an account - the headset is plugged into
 * this machine - so it is kept per browser like the call volumes and the cleanup
 * level, and never sent anywhere.
 *
 * One choice for calls and for voice messages. Picking the good microphone in a
 * call and then being recorded through the lid of a laptop is the kind of
 * surprise that only turns up in the recording, by which time it is somebody
 * else's problem.
 *
 * A device that is no longer plugged in is not an error worth reporting: the
 * remembered choice is asked for as a preference rather than a requirement, so
 * an unplugged headset falls back to whatever the browser hands over instead of
 * refusing to record. That happens in `micConstraints`.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.mic.device";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:mic-device";

/** The one this browser has been told to use, or null for whatever the browser
 *  hands over. */
export function micDevice(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(KEY) || null;
    } catch {
        return null;
    }
}

export function setMicDevice(deviceId: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (deviceId) window.localStorage.setItem(KEY, deviceId);
        else window.localStorage.removeItem(KEY);
    } catch {
        // It still applies to what is open now; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/** One input this browser can offer. */
export interface MicDevice {
    readonly id: string;
    readonly label: string;
}

/**
 * The microphones on this machine, and which one is chosen.
 *
 * Asked after mount and again whenever something is plugged in or unplugged.
 * Names only exist once a microphone permission has been granted, so before the
 * first recording this is a numbered list - which is still enough to pick the
 * second one, and becomes the real names as soon as anything has been recorded.
 */
export function useMicrophones(): {
    readonly devices: readonly MicDevice[];
    readonly chosenId: string | null;
    readonly choose: (deviceId: string) => void;
} {
    const [devices, setDevices] = useState<readonly MicDevice[]>([]);
    const [chosenId, setChosenId] = useState<string | null>(null);

    const look = useCallback(async () => {
        if (typeof navigator?.mediaDevices?.enumerateDevices !== "function") return;
        const found = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        setDevices(
            found
                .filter((device) => device.kind === "audioinput" && device.deviceId)
                .map((device, index) => ({
                    id: device.deviceId,
                    label: device.label || `Microphone ${index + 1}`
                }))
        );
    }, []);

    useEffect(() => {
        setChosenId(micDevice());
        void look();
        const onChosen = () => setChosenId(micDevice());
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
        setMicDevice(deviceId);
    }, []);

    return { devices, chosenId, choose };
}
