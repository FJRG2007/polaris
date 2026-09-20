"use client";

/**
 * What happens to everything behind you, before the camera leaves the browser.
 *
 * Four settings, and like the microphone's they are a ladder rather than a set
 * of switches:
 *
 *   off    - the room as it is. Costs nothing, and is right for most calls.
 *   blur   - the room still legible but out of focus. Enough to take a doorway,
 *            a bed or a whiteboard out of a meeting without pretending to be
 *            somewhere else.
 *   strong - blurred until nothing behind you can be read at all.
 *   image  - a picture of your own in place of the room.
 *
 * Off is the default because it is the only one that costs no battery: a model
 * looks at every frame to decide which pixels are the person, which is a
 * fraction of a core for as long as the call lasts. The assets are fetched at
 * the moment somebody turns it on, not before - see `camera-filter`.
 *
 * Kept per browser, like the microphone cleanup and the volumes: it is a fact
 * about a room and a camera rather than about an account, and the laptop at the
 * kitchen table and the desk in the office want different answers.
 *
 * The image is kept here too, as a data URL, because there is nowhere else for
 * it to be: it never leaves this browser, it is nobody else's business, and
 * uploading a picture of somebody's living room to the server so it can be sent
 * back to the only machine that wanted it would be a worse version of storing
 * it here.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.call.camera-background";
const IMAGE_KEY = "polaris.call.camera-background-image";

/** What somebody who has never touched it gets. */
export const BACKGROUND_DEFAULT: CameraBackground = "off";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:call-camera-background";

/** How the setting is spelled everywhere it is stored or passed. */
export type CameraBackground = "off" | "blur" | "strong" | "image";

const CHOICES: readonly CameraBackground[] = ["off", "blur", "strong", "image"];

/**
 * The settings, in the order somebody would consider them.
 *
 * Written as what each one does to the room rather than as what it is: nobody
 * choosing a camera setting wants to be told the name of a segmentation model.
 */
export const BACKGROUNDS: readonly { value: CameraBackground; label: string; help: string }[] = [
    {
        value: "blur",
        label: "Blur my background",
        help: "Everything except you goes out of focus. Costs a little battery."
    },
    {
        value: "strong",
        label: "Blur it heavily",
        help: "The same, blurred until nothing behind you can be read."
    },
    {
        value: "image",
        label: "Use a picture",
        help: "Replaces the room with an image of yours. It stays on this machine."
    },
    { value: "off", label: "Off", help: "Send the room as the camera sees it." }
];

/**
 * How much the background is blurred, in pixels of the picture being sent.
 *
 * Two numbers rather than a slider: the honest choice here is between "the room
 * is still a room" and "nothing behind me can be read", and every value between
 * them is somebody being asked a question they do not have an answer to.
 */
export const BLUR_PIXELS: Readonly<Record<"blur" | "strong", number>> = {
    blur: 10,
    strong: 25
};

/**
 * The largest picture worth keeping, and what it is kept as.
 *
 * A background is drawn behind a call tile, so anything past 720p is detail
 * nobody will ever see - and a photograph straight off a phone is several
 * megabytes, which is most of what a browser will let this origin store. It is
 * re-encoded on the way in rather than refused: somebody picking a holiday photo
 * should not have to learn what a resolution is.
 */
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;
const IMAGE_QUALITY = 0.75;

/** The largest file worth opening at all. Past this it is not a background,
 *  and decoding it is how a tab runs out of memory. */
const IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * The picture, in memory, so a browser that refused to store it still works.
 *
 * Local storage is the only place this can persist, and it is also the thing
 * most likely to say no - a full quota, a browser with it switched off, a
 * private window. None of those are a reason for the background to fail in the
 * call somebody just chose it in.
 */
let held: string | null = null;

export function cameraBackground(): CameraBackground {
    if (typeof window === "undefined") return BACKGROUND_DEFAULT;
    try {
        const raw = window.localStorage.getItem(KEY);
        // Local storage is editable by whoever owns the browser, so anything
        // that is not one of the four is treated as unset.
        const said = CHOICES.includes(raw as CameraBackground)
            ? (raw as CameraBackground)
            : BACKGROUND_DEFAULT;
        // A picture that is no longer there is not a setting anybody can see the
        // effect of: it would be a camera with nothing behind it.
        return said === "image" && !backgroundImage() ? BACKGROUND_DEFAULT : said;
    } catch {
        return BACKGROUND_DEFAULT;
    }
}

export function setCameraBackground(next: CameraBackground): void {
    if (typeof window === "undefined") return;
    try {
        if (next === BACKGROUND_DEFAULT) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, next);
    } catch {
        // It still applies to this call; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/** The picture somebody chose, or null where they never have. */
export function backgroundImage(): string | null {
    if (held) return held;
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(IMAGE_KEY);
        // Anything that is not an image data URL was not written by this file.
        // It is read back into a canvas below, so what is checked here is only
        // that it is worth trying.
        held = raw?.startsWith("data:image/") ? raw : null;
        return held;
    } catch {
        return null;
    }
}

/**
 * Take a picture from this machine and keep it as the background.
 *
 * Everything about the file is somebody else's - the type, the size, the
 * dimensions, whether it is an image at all - so none of it is believed. It is
 * decoded, and a file that will not decode is not an image whatever its name
 * said; what is then stored is Polaris's own re-encoding at a size a call can
 * use, never the bytes that arrived.
 *
 * Answers the data URL it stored. A file it will not take throws, with a
 * sentence worth putting on screen: a picker that quietly does nothing is worse
 * than one that says the file was not a picture.
 */
export async function rememberBackgroundImage(file: File): Promise<string> {
    if (!file.type.startsWith("image/")) {
        throw new Error("That file is not a picture.");
    }
    if (file.size > IMAGE_BYTES) {
        throw new Error("That picture is too large to use as a background.");
    }

    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) throw new Error("Polaris could not read that picture.");

    // Covering rather than fitting: a background with bars down the sides is a
    // background that reads as a mistake, and the crop is off the edges of a
    // picture nobody is looking at.
    const canvas = document.createElement("canvas");
    canvas.width = IMAGE_WIDTH;
    canvas.height = IMAGE_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Polaris could not read that picture.");

    const scale = Math.max(IMAGE_WIDTH / bitmap.width, IMAGE_HEIGHT / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(
        bitmap,
        (IMAGE_WIDTH - width) / 2,
        (IMAGE_HEIGHT - height) / 2,
        width,
        height
    );
    bitmap.close();

    const encoded = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
    held = encoded;
    try {
        window.localStorage.setItem(IMAGE_KEY, encoded);
    } catch {
        // Kept for this browser session anyway. A quota that is full is not a
        // reason to refuse the background somebody just picked.
    }
    window.dispatchEvent(new Event(CHANGED));
    return encoded;
}

/** The setting, the picture behind it, and the two ways to change them. */
export function useCameraBackground(): {
    background: CameraBackground;
    image: string | null;
    choose: (next: CameraBackground) => void;
    pickImage: (file: File) => Promise<void>;
} {
    const [background, setBackground] = useState<CameraBackground>(BACKGROUND_DEFAULT);
    const [image, setImage] = useState<string | null>(null);

    // After mount, never during render: the server has no local storage, and a
    // value read while rendering would not match what it sent.
    useEffect(() => {
        const read = () => {
            setBackground(cameraBackground());
            setImage(backgroundImage());
        };
        read();
        window.addEventListener(CHANGED, read);
        window.addEventListener("storage", read);
        return () => {
            window.removeEventListener(CHANGED, read);
            window.removeEventListener("storage", read);
        };
    }, []);

    const choose = useCallback((next: CameraBackground) => {
        setBackground(next);
        setCameraBackground(next);
    }, []);

    // Picking a picture is how somebody asks for it to be used: a file chosen
    // and then a second press to turn it on is a step that means nothing.
    const pickImage = useCallback(
        async (file: File) => {
            setImage(await rememberBackgroundImage(file));
            choose("image");
        },
        [choose]
    );

    return { background, image, choose, pickImage };
}
