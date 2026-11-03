"use client";

/**
 * The picture with its translation painted in: each original line covered
 * with the colour around it and the translation written over it, fitted to
 * the line's box. Painted on a canvas in the browser at the picture's own
 * size; nothing of it is sent or kept anywhere.
 */

import { useEffect, useRef } from "react";
import type { ImageLine } from "../model/media";
import { cssColor, fitText, inkFor, sampleBackground, type PixelBox } from "../model/overlay";

/** The smallest and largest text drawn, as a share of the box's height. */
const MIN_SHARE = 0.25;
const MAX_SHARE = 0.85;

/** Paints `translated` over `image` on `canvas`. */
export function paintTranslation(
    canvas: HTMLCanvasElement,
    image: HTMLImageElement,
    lines: readonly ImageLine[],
    translated: readonly string[],
    rightToLeft: boolean
): void {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const font = getComputedStyle(canvas).fontFamily || "sans-serif";
    const measure = (text: string, size: number) => {
        context.font = `${size}px ${font}`;
        return context.measureText(text).width;
    };
    // Every colour first, from the untouched picture, so one cover never tints the next.
    const boxes = lines.map((line): PixelBox | null =>
        line.box
            ? [line.box[0] * width, line.box[1] * height, line.box[2] * width, line.box[3] * height]
            : null
    );
    const colors = boxes.map((box) => (box ? sampleBackground(pixels, box) : null));
    boxes.forEach((box, index) => {
        const background = colors[index];
        const text = translated[index]?.trim();
        if (!box || !background || !text) return;
        const [left, top, boxWidth, boxHeight] = box;
        // A little past the box, so the edges of the original letters go too.
        const pad = Math.max(1, boxHeight * 0.08);
        context.fillStyle = cssColor(background);
        context.fillRect(left - pad, top - pad, boxWidth + pad * 2, boxHeight + pad * 2);
        const fitted = fitText(text, boxWidth, boxHeight, measure, {
            min: Math.max(8, boxHeight * MIN_SHARE),
            max: Math.max(8, boxHeight * MAX_SHARE)
        });
        context.font = `${fitted.size}px ${font}`;
        context.fillStyle = cssColor(inkFor(background));
        context.direction = rightToLeft ? "rtl" : "ltr";
        context.textAlign = rightToLeft ? "right" : "left";
        context.textBaseline = "middle";
        const lineHeight = fitted.size * 1.15;
        const first = top + boxHeight / 2 - ((fitted.lines.length - 1) * lineHeight) / 2;
        const x = rightToLeft ? left + boxWidth : left;
        fitted.lines.forEach((line, row) => context.fillText(line, x, first + row * lineHeight));
    });
}

/** The picture at `url` with `translated` painted over its `lines`. */
export function TranslatedPicture({
    url,
    lines,
    translated,
    rightToLeft,
    label
}: {
    url: string;
    lines: readonly ImageLine[];
    translated: readonly string[];
    rightToLeft: boolean;
    label: string;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const image = new Image();
        let live = true;
        image.onload = () => {
            if (live && canvas.current) {
                paintTranslation(canvas.current, image, lines, translated, rightToLeft);
            }
        };
        image.src = url;
        return () => {
            live = false;
        };
    }, [url, lines, translated, rightToLeft]);

    return (
        <canvas
            ref={canvas}
            role="img"
            aria-label={label}
            className="block h-auto max-h-[70vh] w-auto max-w-full rounded-lg border border-border font-sans"
        />
    );
}
