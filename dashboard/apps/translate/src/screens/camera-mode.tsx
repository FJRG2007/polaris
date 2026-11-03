"use client";

/**
 * The camera, translated as it looks: a frame every few seconds is read and
 * its lines translated over the picture, where they are. A video file plays
 * through the same loop. Lines already translated are kept, so a still scene
 * sends nothing new; a frame waits until the last one is done.
 */

import type { Translate } from "./run";
import { useTranslateT } from "./i18n";
import { Button, CopyButton } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Film, Pause, Play } from "lucide-react";
import { ReadsNotice, TextOverlay, hasLocalReader, readImageText, type ImageLine, type Reads } from "./reads";

/** How often a frame is read: the device's detector is quick, the server's model is not. */
const LOCAL_EVERY_MS = 2000;
const SERVER_EVERY_MS = 5000;
/** The longest side a frame is sent at. */
const FRAME_MAX = 1280;

/** One frame of `video` as a JPEG, no larger than `FRAME_MAX` on its longest side. */
async function frameOf(video: HTMLVideoElement): Promise<Blob | null> {
    const scale = Math.min(1, FRAME_MAX / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
}

export function CameraMode({
    translate,
    reads,
    manager
}: {
    translate: Translate;
    reads: Reads;
    manager: boolean;
}) {
    const t = useTranslateT();
    const video = useRef<HTMLVideoElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const stream = useRef<MediaStream | null>(null);
    const fileUrl = useRef<string | null>(null);
    const busy = useRef(false);
    const known = useRef(new Map<string, string>());
    const [running, setRunning] = useState(false);
    const [paused, setPaused] = useState(false);
    const [lines, setLines] = useState<ImageLine[]>([]);
    const [translated, setTranslated] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [height, setHeight] = useState(0);
    const [local, setLocal] = useState(false);
    const [canCamera, setCanCamera] = useState(true);

    useEffect(() => {
        setLocal(hasLocalReader());
        setCanCamera(typeof navigator.mediaDevices?.getUserMedia === "function");
    }, []);

    // A new language or engine: what was translated before no longer holds.
    useEffect(() => {
        known.current = new Map();
        setTranslated(null);
    }, [translate]);

    const release = useCallback(() => {
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
        if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
        fileUrl.current = null;
        const element = video.current;
        if (element) {
            element.pause();
            element.srcObject = null;
            element.removeAttribute("src");
        }
        setRunning(false);
        setPaused(false);
        setLines([]);
        setTranslated(null);
    }, []);

    useEffect(() => release, [release]);

    const startCamera = async () => {
        setError(null);
        release();
        try {
            const media = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: "environment" } },
                audio: false
            });
            stream.current = media;
            const element = video.current!;
            element.srcObject = media;
            await element.play();
            setRunning(true);
        } catch {
            setError(t("camera.denied"));
        }
    };

    const startFile = async (file: File) => {
        setError(null);
        release();
        const element = video.current!;
        fileUrl.current = URL.createObjectURL(file);
        element.src = fileUrl.current;
        try {
            await element.play();
            setRunning(true);
        } catch {
            release();
            setError(t("camera.videoFailed"));
        }
    };

    const tick = useCallback(async () => {
        const element = video.current;
        if (!element || busy.current || element.readyState < 2 || !element.videoWidth) return;
        busy.current = true;
        try {
            const frame = await frameOf(element);
            if (!frame) return;
            const found = await readImageText(frame, {
                server: reads.images,
                fallback: t("errors.readFailed")
            });
            const missing = [
                ...new Set(found.map((line) => line.text).filter((text) => !known.current.has(text)))
            ];
            // A long session meets many lines; what it keeps stays bounded.
            if (known.current.size > 500) known.current = new Map();
            if (missing.length > 0) {
                const answer = await translate(missing);
                missing.forEach((text, index) => known.current.set(text, answer.texts[index] ?? ""));
            }
            setLines(found);
            setTranslated(found.map((line) => known.current.get(line.text) ?? ""));
            setError(null);
        } catch (caught) {
            setError((caught as Error).message);
        } finally {
            busy.current = false;
        }
    }, [reads.images, translate, t]);

    useEffect(() => {
        if (!running || paused) return;
        const every = local ? LOCAL_EVERY_MS : SERVER_EVERY_MS;
        void tick();
        const timer = window.setInterval(() => void tick(), every);
        return () => window.clearInterval(timer);
    }, [running, paused, local, tick]);

    useEffect(() => {
        const element = video.current;
        if (!element) return;
        const observer = new ResizeObserver(() => setHeight(element.clientHeight));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    if (!reads.images && !local) return <ReadsNotice kind="images" manager={manager} />;

    const translation = (translated ?? []).filter(Boolean).join("\n");

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <input
                ref={fileInput}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void startFile(file);
                }}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {running ? (
                    <>
                        <Button variant="outline" size="sm" onClick={release}>
                            <CameraOff className="size-4 shrink-0" aria-hidden />
                            {t("camera.stop")}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setPaused((now) => !now)}
                            aria-label={paused ? t("camera.resume") : t("camera.pause")}
                            title={paused ? t("camera.resume") : t("camera.pause")}
                        >
                            {paused ? (
                                <Play className="size-4 shrink-0" aria-hidden />
                            ) : (
                                <Pause className="size-4 shrink-0" aria-hidden />
                            )}
                        </Button>
                    </>
                ) : (
                    <Button size="sm" onClick={() => void startCamera()} disabled={!canCamera}>
                        <Camera className="size-4 shrink-0" aria-hidden />
                        {t("camera.start")}
                    </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                    <Film className="size-4 shrink-0" aria-hidden />
                    {t("camera.video")}
                </Button>
                <CopyButton value={translation} label={t("actions.copy")} className="ml-auto" />
            </div>
            <div className="relative mx-auto w-fit max-w-full">
                <video
                    ref={video}
                    muted
                    playsInline
                    loop
                    className={running ? "block max-h-[70vh] max-w-full rounded-lg border border-border bg-black" : "hidden"}
                />
                {running ? <TextOverlay lines={lines} translated={translated} height={height} /> : null}
            </div>
            <p className="text-xs text-muted-foreground" role="status">
                {error ? (
                    <span className="text-destructive">{error}</span>
                ) : !canCamera ? (
                    t("camera.unsupported")
                ) : running && lines.length === 0 ? (
                    t("camera.waiting")
                ) : running ? null : (
                    t("camera.hint")
                )}
            </p>
        </div>
    );
}
