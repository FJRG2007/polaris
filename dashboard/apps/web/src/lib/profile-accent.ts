"use client";

/**
 * The colour a profile falls back to when nobody has put a banner up.
 *
 * Almost nobody will. A profile whose top half is a grey rectangle for everybody
 * except the three people who uploaded a picture is worse than no banner at all,
 * so the default is taken from the one thing that account already has: its face.
 * The most abundant colour in somebody's photo, drawn as a band with a shade of
 * itself, is a banner they never had to choose and that still belongs to them -
 * which is exactly what every client that does this is doing.
 *
 * It is worked out in the browser, from the picture already on screen. The
 * alternative is a column computed at upload, and that column would be wrong for
 * every face that does not come from an upload: a Gravatar is fetched by the
 * server on demand, and initials are drawn by the client from a tint that has
 * never been near the database. One canvas of 16 by 16 pixels, once per person
 * per page, costs nothing and cannot be out of date.
 *
 * The maths is separate from the fetching so it can be tested without a browser.
 */

import { useEffect, useState } from "react";
import { avatarUrl } from "@/lib/avatar-url";

/** A colour, the way CSS wants to be handed one. */
export interface Accent {
    /** 0-360. */
    readonly hue: number;
    /** 0-100. */
    readonly saturation: number;
    /** 0-100. */
    readonly lightness: number;
}

export function cssColor(accent: Accent): string {
    return `hsl(${Math.round(accent.hue)} ${Math.round(accent.saturation)}% ${Math.round(accent.lightness)}%)`;
}

/**
 * The band drawn behind a profile: the colour, and a shade of itself.
 *
 * A flat rectangle of one colour reads as a missing image; the same colour
 * walked a little around the wheel and a little darker reads as a decision. The
 * step is small on purpose - this is a background for somebody else's face, not
 * a gradient anybody should notice.
 */
export function accentGradient(accent: Accent): string {
    const far: Accent = {
        hue: (accent.hue + 16) % 360,
        saturation: clamp(accent.saturation - 6, 0, 100),
        lightness: clamp(accent.lightness - 14, 6, 94)
    };
    return `linear-gradient(135deg, ${cssColor(accent)} 0%, ${cssColor(far)} 100%)`;
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

/** How wide a slice of the wheel counts as one colour. Fifteen degrees keeps a
 *  red shirt and an orange wall apart without splitting one of them in two. */
const BUCKET_DEGREES = 15;

/** Below this a pixel is grey rather than a colour, and counting it as one would
 *  make every photograph with a lot of sky or skin come out beige. */
const COLOURFUL = 0.12;

/**
 * The most abundant colour in a picture, or null when there is not one.
 *
 * Pixels are weighted by how colourful they are rather than counted: a
 * photograph is mostly muddy midtones, and a plain count hands the answer to
 * whichever grey there happens to be the most of. Fully transparent pixels and
 * the extremes of black and white are left out for the same reason - they are
 * the background of a cut-out, not what the picture is of.
 *
 * Null means the picture had no colour in it at all (a black-and-white photo, a
 * blank pixel); the caller has its own fallback and this must not invent one.
 */
export function dominantColor(pixels: Uint8ClampedArray): Accent | null {
    const buckets = new Map<number, { weight: number; sin: number; cos: number; saturation: number; lightness: number }>();

    for (let index = 0; index + 3 < pixels.length; index += 4) {
        const alpha = pixels[index + 3]!;
        if (alpha < 128) continue;
        const { hue, saturation, lightness } = toHsl(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!);
        if (saturation < COLOURFUL || lightness < 0.08 || lightness > 0.92) continue;

        const key = Math.floor(hue / BUCKET_DEGREES);
        const bucket = buckets.get(key) ?? { weight: 0, sin: 0, cos: 0, saturation: 0, lightness: 0 };
        const weight = saturation;
        const radians = (hue * Math.PI) / 180;
        bucket.weight += weight;
        bucket.sin += Math.sin(radians) * weight;
        bucket.cos += Math.cos(radians) * weight;
        bucket.saturation += saturation * weight;
        bucket.lightness += lightness * weight;
        buckets.set(key, bucket);
    }

    let best: { weight: number; sin: number; cos: number; saturation: number; lightness: number } | null = null;
    for (const bucket of buckets.values()) {
        if (!best || bucket.weight > best.weight) best = bucket;
    }
    if (!best || best.weight === 0) return null;

    // Averaged around the circle rather than arithmetically: hue 350 and hue 10
    // are neighbours, and their mean is 0 rather than 180.
    const hue = (((Math.atan2(best.sin, best.cos) * 180) / Math.PI) + 360) % 360;
    return {
        hue,
        // Held inside a band that stays a background. A photograph of a neon sign
        // would otherwise put a fully saturated stripe behind somebody's face,
        // and a washed-out one would put a rectangle that reads as broken.
        saturation: clamp((best.saturation / best.weight) * 100, 30, 70),
        lightness: clamp((best.lightness / best.weight) * 100, 32, 52)
    };
}

/** RGB in 0-255 to HSL with hue in degrees and the rest in 0-1. */
function toHsl(red: number, green: number, blue: number): { hue: number; saturation: number; lightness: number } {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    const lightness = (high + low) / 2;
    const span = high - low;
    if (span === 0) return { hue: 0, saturation: 0, lightness };

    const saturation = span / (1 - Math.abs(2 * lightness - 1));
    let hue: number;
    if (high === r) hue = ((g - b) / span) % 6;
    else if (high === g) hue = (b - r) / span + 2;
    else hue = (r - g) / span + 4;
    return { hue: (hue * 60 + 360) % 360, saturation, lightness };
}

/**
 * The colour worked out for one account, remembered for the session.
 *
 * A profile is opened, closed and opened again; the same face should not be
 * decoded twice. Module level rather than component state, for the same reason
 * the avatar component keeps its preload set there.
 */
const known = new Map<string, Accent | null>();

/** How big a picture is sampled at. Any bigger is more pixels saying the same
 *  thing; any smaller and a face's own colour starts to disappear into the
 *  background it was photographed against. */
const SAMPLE = 16;

/**
 * The accent for one account's face, or null while it is being worked out and
 * for a face that has no picture behind it.
 *
 * Reads the picture the browser has almost certainly already fetched - the same
 * URL the avatar draws - so this is a cache hit and a decode rather than a
 * request. Same origin, so the canvas is not tainted and the pixels can be read.
 */
export function useAccent(userId: string | null): Accent | null {
    const [accent, setAccent] = useState<Accent | null>(() => (userId ? (known.get(userId) ?? null) : null));

    useEffect(() => {
        if (!userId) {
            setAccent(null);
            return;
        }
        if (known.has(userId)) {
            setAccent(known.get(userId) ?? null);
            return;
        }
        let live = true;
        const picture = new window.Image();
        picture.decoding = "async";
        picture.onload = () => {
            // The blank pixel served for an account with no photo is one pixel
            // across. There is nothing to take a colour from, and the tint the
            // initials are drawn on is a better answer than a colour invented
            // from a transparent pixel.
            const accent = picture.naturalWidth > 1 ? sample(picture) : null;
            known.set(userId, accent);
            if (live) setAccent(accent);
        };
        picture.onerror = () => {
            known.set(userId, null);
            if (live) setAccent(null);
        };
        picture.src = avatarUrl(userId);
        return () => {
            live = false;
        };
    }, [userId]);

    return accent;
}

/** Draw the picture small and read the pixels back. Null when the browser will
 *  not give them up - a canvas with no 2D context, or bytes it considers
 *  cross-origin - which is a colour not found rather than an error. */
function sample(picture: HTMLImageElement): Accent | null {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(picture, 0, 0, SAMPLE, SAMPLE);
        return dominantColor(context.getImageData(0, 0, SAMPLE, SAMPLE).data);
    } catch {
        return null;
    }
}
