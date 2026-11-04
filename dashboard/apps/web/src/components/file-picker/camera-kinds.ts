/**
 * What the picker's camera can hand a screen, read from the screen's `accept`.
 *
 * A screen that takes pictures gets "Take a photo"; one that takes video gets
 * "Record a video"; one that takes neither (a spreadsheet import, a sound) is
 * never offered the camera at all. A screen that names nothing takes anything,
 * so it gets both - the same way the browser's own chooser offers the camera
 * on a phone for a bare file input.
 *
 * Pure, so which callers show the camera is asserted in a test.
 */

export interface CameraKinds {
    /** The picture type a photo is saved as, or null when no photo is taken. */
    readonly photo: "image/jpeg" | "image/png" | "image/webp" | null;
    /** Whether a recorded video is something the screen takes. */
    readonly video: boolean;
}

const PHOTO_TYPES = [
    { type: "image/jpeg", names: [".jpg", ".jpeg"] },
    { type: "image/png", names: [".png"] },
    { type: "image/webp", names: [".webp"] }
] as const;

const VIDEO_NAMES = [".webm", ".mp4", ".mov", ".m4v"];

export function cameraKinds(accept: string | undefined, storageOnly = false): CameraKinds {
    if (storageOnly) return { photo: null, video: false };
    const wanted = (accept ?? "")
        .split(",")
        .map((one) => one.trim().toLowerCase())
        .filter(Boolean);
    if (wanted.length === 0) return { photo: "image/jpeg", video: true };
    const anyImage = wanted.includes("image/*");
    const photo =
        PHOTO_TYPES.find(
            (one) =>
                anyImage ||
                wanted.includes(one.type) ||
                one.names.some((name) => wanted.includes(name))
        )?.type ?? null;
    const video = wanted.some(
        (one) => one === "video/*" || one.startsWith("video/") || VIDEO_NAMES.includes(one)
    );
    return { photo, video };
}

/** Whether this device can take a picture at all: a camera the browser lists,
 *  or a phone, whose file input opens the camera even where it lists none. */
export async function cameraAvailable(scope: {
    navigator?: { mediaDevices?: { enumerateDevices?: () => Promise<{ kind: string }[]> } };
    matchMedia?: (query: string) => { matches: boolean };
}): Promise<boolean> {
    const phone = scope.matchMedia?.("(pointer: coarse)").matches ?? false;
    try {
        const devices = (await scope.navigator?.mediaDevices?.enumerateDevices?.()) ?? null;
        if (devices) return devices.some((device) => device.kind === "videoinput") || phone;
    } catch {
        // Listing devices refused: fall through to what the device is.
    }
    return phone;
}
