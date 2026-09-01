"use client";

/**
 * Which camera this browser uses.
 *
 * The microphone has had one of these since there was a reason to pick one; the
 * camera never did, so a machine with a webcam and a capture card opened
 * whichever the browser felt like - and the only way to find out which was to
 * turn the camera on in front of people.
 *
 * A fact about a room rather than about an account, like the microphone and the
 * volumes: kept per browser and never sent anywhere.
 *
 * Asked for as a preference rather than a requirement. A remembered id names a
 * camera that may have been unplugged three days ago, and that must never be the
 * reason a call opens with no picture at all.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.camera.device";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:camera-device";

/** The one this browser has been told to use, or null for whatever the browser
 *  hands over. */
export function cameraDevice(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(KEY) || null;
    } catch {
        return null;
    }
}

export function setCameraDevice(deviceId: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (deviceId) window.localStorage.setItem(KEY, deviceId);
        else window.localStorage.removeItem(KEY);
    } catch {
        // It still applies to what is open now; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/** The remembered camera folded into whatever size is being asked for, as a
 *  preference. Nothing when this browser has never chosen one. */
export function withCameraDevice(constraints: MediaTrackConstraints): MediaTrackConstraints {
    const remembered = cameraDevice();
    return remembered ? { ...constraints, deviceId: { ideal: remembered } } : constraints;
}

/** One camera this browser can offer. */
export interface CameraDevice {
    readonly id: string;
    readonly label: string;
}

/**
 * The cameras on this machine, and which one is chosen.
 *
 * Asked after mount and again whenever something is plugged in or unplugged.
 * Names only exist once a camera permission has been granted, so before the
 * first one is opened this is a numbered list - which is still enough to pick
 * the second one, and becomes the real names as soon as the preview runs.
 */
export function useCameras(): {
    readonly devices: readonly CameraDevice[];
    readonly chosenId: string | null;
    readonly choose: (deviceId: string | null) => void;
} {
    const [devices, setDevices] = useState<readonly CameraDevice[]>([]);
    const [chosenId, setChosenId] = useState<string | null>(null);

    const look = useCallback(async () => {
        if (typeof navigator?.mediaDevices?.enumerateDevices !== "function") return;
        const found = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        setDevices(
            found
                .filter((device) => device.kind === "videoinput" && device.deviceId)
                .map((device, index) => ({
                    id: device.deviceId,
                    label: device.label || `Camera ${index + 1}`
                }))
        );
    }, []);

    useEffect(() => {
        setChosenId(cameraDevice());
        void look();
        const onChosen = () => setChosenId(cameraDevice());
        window.addEventListener(CHANGED, onChosen);
        window.addEventListener("storage", onChosen);
        navigator.mediaDevices?.addEventListener?.("devicechange", look);
        return () => {
            window.removeEventListener(CHANGED, onChosen);
            window.removeEventListener("storage", onChosen);
            navigator.mediaDevices?.removeEventListener?.("devicechange", look);
        };
    }, [look]);

    const choose = useCallback((deviceId: string | null) => {
        setChosenId(deviceId);
        setCameraDevice(deviceId);
    }, []);

    return { devices, chosenId, choose };
}
