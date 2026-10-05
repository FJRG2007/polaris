"use client";

/**
 * How the camera's own picture looks: its light, its colour, and where you sit
 * in it. The background is `camera-background`'s; this is everything else that
 * is done to the frame before it leaves the browser.
 *
 * Three settings, each a short ladder rather than a slider, for the reason the
 * background's blur is two numbers: the choice somebody actually has is "my
 * room is dark" or "keep me in the middle", and a slider from 0 to 200 is a
 * question they have no answer to.
 *
 *   light - off, auto (lifts a dark picture by measuring it, a few times a
 *           second, and leaves a well-lit one alone), or brighter (a fixed
 *           lift for a room that is always dim).
 *   style - a colour treatment: warm, cool, vivid, soft, or black and white.
 *   frame - off, or auto: follows the person and crops in on them, so
 *           somebody sitting off to one side, or far from the camera, is in the
 *           middle of their tile.
 *
 * All of it is a canvas filter or a crop, drawn in this browser - nothing about
 * the picture goes anywhere to be processed. Auto framing needs to know where
 * the person is, which is the segmentation model the background already uses
 * (see `camera-filter`); the light and the style need no model at all.
 *
 * Kept per browser, like the background: a fact about a room and a camera.
 *
 * Pure helpers below are the parts with arithmetic in them - the filter a look
 * becomes, the gain a dark frame earns, where a person is in a mask and how the
 * crop follows them - so they can be checked without a camera.
 */

import { z } from "zod";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.call.camera-look";
/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:call-camera-look";

export const CAMERA_LIGHTS = ["off", "auto", "bright"] as const;
export const CAMERA_STYLES = ["none", "warm", "cool", "vivid", "soft", "mono"] as const;
export const CAMERA_FRAMES = ["off", "auto"] as const;

export type CameraLight = (typeof CAMERA_LIGHTS)[number];
export type CameraStyle = (typeof CAMERA_STYLES)[number];
export type CameraFrame = (typeof CAMERA_FRAMES)[number];

/** Local storage belongs to whoever owns the browser, so a stored look is read
 *  field by field and anything unknown falls back rather than failing. */
const lookSchema = z.object({
    light: z.enum(CAMERA_LIGHTS).catch("off"),
    style: z.enum(CAMERA_STYLES).catch("none"),
    frame: z.enum(CAMERA_FRAMES).catch("off")
});

export type CameraLook = z.infer<typeof lookSchema>;

/** The picture as the camera took it. */
export const LOOK_DEFAULT: CameraLook = { light: "off", style: "none", frame: "off" };

/** The options, as the menus list them. */
export const LIGHT_CHOICES: readonly { value: CameraLight; label: NamespaceKey<"chat"> }[] = [
    { value: "off", label: "callSettings.look.light.off" },
    { value: "auto", label: "callSettings.look.light.auto" },
    { value: "bright", label: "callSettings.look.light.bright" }
];

export const STYLE_CHOICES: readonly { value: CameraStyle; label: NamespaceKey<"chat"> }[] = [
    { value: "none", label: "callSettings.look.style.none" },
    { value: "warm", label: "callSettings.look.style.warm" },
    { value: "cool", label: "callSettings.look.style.cool" },
    { value: "vivid", label: "callSettings.look.style.vivid" },
    { value: "soft", label: "callSettings.look.style.soft" },
    { value: "mono", label: "callSettings.look.style.mono" }
];

export const FRAME_CHOICES: readonly { value: CameraFrame; label: NamespaceKey<"chat"> }[] = [
    { value: "off", label: "callSettings.look.frame.off" },
    { value: "auto", label: "callSettings.look.frame.auto" }
];

/** Read a stored look, whatever was stored. */
export function parseCameraLook(raw: string | null): CameraLook {
    if (!raw) return LOOK_DEFAULT;
    try {
        const parsed = lookSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : LOOK_DEFAULT;
    } catch {
        return LOOK_DEFAULT;
    }
}

export function cameraLook(): CameraLook {
    if (typeof window === "undefined") return LOOK_DEFAULT;
    try {
        return parseCameraLook(window.localStorage.getItem(KEY));
    } catch {
        return LOOK_DEFAULT;
    }
}

export function setCameraLook(next: CameraLook): void {
    if (typeof window === "undefined") return;
    try {
        if (lookIsPlain(next)) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // It still applies to this call; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/** Whether nothing at all is done to the picture. */
export function lookIsPlain(look: CameraLook): boolean {
    return look.light === "off" && look.style === "none" && look.frame === "off";
}

/** One string per look, for "has this already been acted on". */
export function lookKey(look: CameraLook): string {
    return `${look.light}/${look.style}/${look.frame}`;
}

/** The colour treatments, as canvas filters. Mild on purpose: a call is not a
 *  photo app, and a treatment that is noticed before the person is too much. */
const STYLE_FILTERS: Readonly<Record<CameraStyle, string>> = {
    none: "",
    warm: "sepia(0.18) saturate(1.1) hue-rotate(-6deg)",
    cool: "saturate(0.95) hue-rotate(8deg) brightness(1.02)",
    vivid: "saturate(1.35) contrast(1.08)",
    soft: "contrast(0.92) brightness(1.04) saturate(0.9)",
    mono: "grayscale(1) contrast(1.1)"
};

/** The fixed lift "brighter" applies. */
const BRIGHT_FILTER = "brightness(1.22) contrast(1.05)";

/**
 * The filter a look becomes, given the gain auto light has settled on.
 *
 * Light before colour: the treatments are tuned for a picture that is already
 * exposed, and a grey filter on a dark frame is a darker frame.
 */
export function lookFilter(look: CameraLook, gain = 1): string {
    const parts: string[] = [];
    if (look.light === "bright") parts.push(BRIGHT_FILTER);
    if (look.light === "auto" && gain > 1.01) {
        // A lifted dark picture is a flat one; a touch of contrast puts the
        // edges back. Proportional, so a nearly-right picture is barely touched.
        parts.push(`brightness(${round(gain)}) contrast(${round(1 + (gain - 1) * 0.15)})`);
    }
    const style = STYLE_FILTERS[look.style];
    if (style) parts.push(style);
    return parts.length > 0 ? parts.join(" ") : "none";
}

/** The exposure auto light aims for, as mean luminance from 0 to 1. */
const TARGET_LUMA = 0.45;
/** At or above this the picture is left alone. */
const BRIGHT_ENOUGH = 0.38;
/** Never more than this: past it the noise a dark sensor makes is the picture. */
const MAX_GAIN = 1.7;

/** Mean luminance of an RGBA sample, 0 to 1. */
export function meanLuma(pixels: ArrayLike<number>): number {
    let total = 0;
    let count = 0;
    for (let at = 0; at + 3 < pixels.length; at += 4) {
        total +=
            0.2126 * (pixels[at] ?? 0) +
            0.7152 * (pixels[at + 1] ?? 0) +
            0.0722 * (pixels[at + 2] ?? 0);
        count += 1;
    }
    return count > 0 ? total / count / 255 : 0;
}

/** The brightness a frame this bright should get. Only ever lifts. */
export function autoGain(luma: number): number {
    if (!(luma > 0) || luma >= BRIGHT_ENOUGH) return 1;
    return Math.min(MAX_GAIN, Math.max(1, TARGET_LUMA / luma));
}

/** A rectangle in fractions of the frame, 0 to 1 on both axes. */
export interface FrameBox {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export const WHOLE_FRAME: FrameBox = { x: 0, y: 0, w: 1, h: 1 };

/** Less of the frame than this marked as a person is nobody - a hand at the
 *  edge, or noise in an empty room - and the crop goes back to the whole. */
const MIN_PERSON = 0.02;

/**
 * Where the person is, from a segmentation mask's alpha channel.
 *
 * Read from a small copy of the mask (a few dozen pixels a side): the box is
 * for aiming a crop, and a box accurate to a pixel of a 1280-wide frame is
 * precision nobody can see. Null when there is nobody there.
 */
export function personBox(
    pixels: ArrayLike<number>,
    width: number,
    height: number
): FrameBox | null {
    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;
    let found = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if ((pixels[(y * width + x) * 4 + 3] ?? 0) < 128) continue;
            found += 1;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }
    if (found < width * height * MIN_PERSON) return null;
    return {
        x: left / width,
        y: top / height,
        w: (right - left + 1) / width,
        h: (bottom - top + 1) / height
    };
}

/** The closest it zooms: past this a webcam's picture goes soft. */
const MAX_ZOOM = 1.6;
/** How much of the crop's height the person should fill. */
const PERSON_SHARE = 0.75;
/** How far below the top of the crop the top of their head sits. */
const HEADROOM = 0.08;

/**
 * The crop that frames a person, keeping the frame's own shape.
 *
 * The crop is the same fraction of the width as of the height, so what is sent
 * is the camera's aspect, only closer. Kept inside the frame: a crop that ran
 * off the edge would draw nothing there.
 */
export function frameFor(person: FrameBox | null): FrameBox {
    if (!person) return WHOLE_FRAME;
    const size = Math.min(
        1,
        Math.max(1 / MAX_ZOOM, person.h / PERSON_SHARE, person.w / PERSON_SHARE)
    );
    const centerX = person.x + person.w / 2;
    const top = person.y - size * HEADROOM;
    return {
        x: clamp(centerX - size / 2, 0, 1 - size),
        y: clamp(top, 0, 1 - size),
        w: size,
        h: size
    };
}

/** How far the crop moves towards where it is going, per frame. */
const FOLLOW = 0.06;
/** Movement smaller than this is not followed at all: a crop that tracks every
 *  breath is a picture that never sits still. */
const DEAD_ZONE = 0.03;

/**
 * One frame's step from the crop on screen towards the one wanted.
 *
 * Eased rather than jumped, and still within a dead zone, so the picture glides
 * after somebody who moves and stays put while they talk.
 */
export function followFrame(current: FrameBox, wanted: FrameBox): FrameBox {
    const far =
        Math.abs(current.x - wanted.x) > DEAD_ZONE ||
        Math.abs(current.y - wanted.y) > DEAD_ZONE ||
        Math.abs(current.w - wanted.w) > DEAD_ZONE;
    if (!far) return current;
    const step = (from: number, to: number) => from + (to - from) * FOLLOW;
    const size = step(current.w, wanted.w);
    return {
        x: clamp(step(current.x, wanted.x), 0, 1 - size),
        y: clamp(step(current.y, wanted.y), 0, 1 - size),
        w: size,
        h: size
    };
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/** The look, and the one way to change it. */
export function useCameraLook(): {
    look: CameraLook;
    change: (patch: Partial<CameraLook>) => void;
} {
    const [look, setLook] = useState<CameraLook>(LOOK_DEFAULT);

    // After mount, never during render: the server has no local storage.
    useEffect(() => {
        const read = () => setLook(cameraLook());
        read();
        window.addEventListener(CHANGED, read);
        window.addEventListener("storage", read);
        return () => {
            window.removeEventListener(CHANGED, read);
            window.removeEventListener("storage", read);
        };
    }, []);

    const change = useCallback((patch: Partial<CameraLook>) => {
        const next = { ...cameraLook(), ...patch };
        setLook(next);
        setCameraLook(next);
    }, []);

    return { look, change };
}
