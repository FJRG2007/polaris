"use client";

/**
 * What the modes that read something other than typed text share: whether
 * this Polaris can read pictures and recordings, the line that says so when
 * it cannot (with the button that fixes it, for an administrator), and the
 * reading itself - the browser's own text detector first, the server's model
 * after.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { useTranslateT } from "./i18n";
import { postFile } from "./server-engine";
import type { ImageLine } from "../model/media";

export interface Reads {
    /** The server can read the text in a picture. */
    images: boolean;
    /** The server can transcribe a recording. */
    audio: boolean;
}

export type { ImageLine };

/** Why a mode cannot work here, and for an administrator the way to fix it. */
export function ReadsNotice({ kind, manager }: { kind: "images" | "audio"; manager: boolean }) {
    const t = useTranslateT();
    const text =
        kind === "images"
            ? manager
                ? t("reads.imagesManager")
                : t("reads.imagesReader")
            : manager
              ? t("reads.audioManager")
              : t("reads.audioReader");
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">{text}</p>
            {manager ? (
                <Button asChild size="sm" variant="outline">
                    <Link href="/admin/integrations/models">{t("reads.setUp")}</Link>
                </Button>
            ) : null}
        </div>
    );
}

interface DetectedText {
    rawValue: string;
    boundingBox: { x: number; y: number; width: number; height: number };
}

interface TextDetectorApi {
    detect(source: ImageBitmapSource): Promise<DetectedText[]>;
}

type TextDetectorClass = new () => TextDetectorApi;

/**
 * The browser's own text detector (the Shape Detection API, wicg.github.io/
 * shape-detection-api/text.html), where it has one. Nothing leaves the device.
 */
function textDetector(): TextDetectorClass | null {
    const api = (globalThis as { TextDetector?: unknown }).TextDetector;
    return typeof api === "function" ? (api as TextDetectorClass) : null;
}

export function hasLocalReader(): boolean {
    return textDetector() !== null;
}

/** Top to bottom, then left to right, as a page is read. */
function inReadingOrder(lines: ImageLine[]): ImageLine[] {
    return [...lines].sort((a, b) => {
        if (!a.box || !b.box) return 0;
        const sameRow = Math.abs(a.box[1] - b.box[1]) < Math.min(a.box[3], b.box[3]) / 2;
        return sameRow ? a.box[0] - b.box[0] : a.box[1] - b.box[1];
    });
}

async function readLocally(image: Blob): Promise<ImageLine[]> {
    const Detector = textDetector();
    if (!Detector) return [];
    try {
        const bitmap = await createImageBitmap(image);
        const { width, height } = bitmap;
        const found = await new Detector().detect(bitmap);
        bitmap.close();
        return inReadingOrder(
            found
                .filter((item) => item.rawValue.trim())
                .map((item) => ({
                    text: item.rawValue,
                    box: [
                        item.boundingBox.x / width,
                        item.boundingBox.y / height,
                        item.boundingBox.width / width,
                        item.boundingBox.height / height
                    ]
                }))
        );
    } catch {
        // The detector exists but could not run (an unsupported platform): the server reads it.
        return [];
    }
}

/**
 * The lines of text in `image`: the browser's detector when it finds any,
 * else the server's model when it can read pictures. Throws an Error with
 * the sentence to show.
 */
export async function readImageText(
    image: Blob,
    options: { server: boolean; fallback: string; signal?: AbortSignal }
): Promise<ImageLine[]> {
    const local = await readLocally(image);
    if (local.length > 0 || !options.server) return local;
    const answer = await postFile<{ lines: ImageLine[] }>(
        "/api/translate/image",
        image,
        options.fallback,
        options.signal
    );
    return inReadingOrder(answer.lines);
}

/** The translated lines drawn over a picture or a video, each where its original is. */
export function TextOverlay({
    lines,
    translated,
    height
}: {
    lines: readonly ImageLine[];
    translated: readonly string[] | null;
    /** The drawn height of what is under it, in pixels, to size the text. */
    height: number;
}) {
    if (!translated) return null;
    return (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
            {lines.map((line, index) =>
                line.box ? (
                    <span
                        key={index}
                        dir="auto"
                        className="absolute overflow-hidden rounded-sm bg-background/90 px-0.5 leading-tight text-foreground shadow-sm [overflow-wrap:anywhere]"
                        style={{
                            left: `${line.box[0] * 100}%`,
                            top: `${line.box[1] * 100}%`,
                            width: `${line.box[2] * 100}%`,
                            minHeight: `${line.box[3] * 100}%`,
                            fontSize: `${Math.max(9, Math.min(40, height * line.box[3] * 0.7))}px`
                        }}
                    >
                        {translated[index] ?? ""}
                    </span>
                ) : null
            )}
        </div>
    );
}
