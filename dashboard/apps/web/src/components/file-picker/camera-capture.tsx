"use client";

/**
 * The picker's camera: a photo or a video taken now, handed back as a file
 * like one chosen from the machine.
 *
 * On a phone the browser's own camera does it better than a page can, so the
 * buttons open it (`capture`) and the gallery beside it. On a computer the
 * camera is shown here (`getUserMedia`) and a photo is the frame on screen,
 * a video what was recorded until Stop. Only what the screen takes is offered
 * (`camera-kinds.ts`); the picker hides the whole tab when no camera exists.
 */

import { Button } from "@polaris/ui";
import type { CameraKinds } from "./camera-kinds";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Camera, Circle, Images, Square, Video } from "lucide-react";

const EXTENSION: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm"
};

function stamp(): string {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

export function CameraCapture({
    kinds,
    phone,
    onFiles
}: {
    kinds: CameraKinds;
    /** A touch device: the browser's own camera and gallery, not a preview here. */
    phone: boolean;
    onFiles: (files: File[]) => void;
}) {
    const t = useTranslations("components");
    const video = useRef<HTMLVideoElement>(null);
    const stream = useRef<MediaStream | null>(null);
    const recorder = useRef<MediaRecorder | null>(null);
    const photoInput = useRef<HTMLInputElement>(null);
    const videoInput = useRef<HTMLInputElement>(null);
    const galleryInput = useRef<HTMLInputElement>(null);
    const [live, setLive] = useState(false);
    const [recording, setRecording] = useState(false);
    const [problem, setProblem] = useState("");

    const galleryAccept = [kinds.photo ? "image/*" : "", kinds.video ? "video/*" : ""]
        .filter(Boolean)
        .join(",");

    useEffect(() => {
        if (phone) return;
        let gone = false;
        void (async () => {
            try {
                const media = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: kinds.video
                });
                if (gone) return media.getTracks().forEach((track) => track.stop());
                stream.current = media;
                if (video.current) {
                    video.current.srcObject = media;
                    await video.current.play().catch(() => undefined);
                }
                setLive(true);
            } catch {
                if (!gone) setProblem(t("files.camera.denied"));
            }
        })();
        return () => {
            gone = true;
            if (recorder.current?.state === "recording") recorder.current.stop();
            stream.current?.getTracks().forEach((track) => track.stop());
            stream.current = null;
        };
    }, [phone, kinds.video, t]);

    function snap(): void {
        const element = video.current;
        if (!element || !kinds.photo || !element.videoWidth) return;
        const canvas = document.createElement("canvas");
        canvas.width = element.videoWidth;
        canvas.height = element.videoHeight;
        canvas.getContext("2d")?.drawImage(element, 0, 0);
        const type = kinds.photo;
        canvas.toBlob(
            (blob) => {
                if (!blob) return setProblem(t("files.camera.failed"));
                onFiles([new File([blob], `photo-${stamp()}.${EXTENSION[type]}`, { type })]);
            },
            type,
            0.92
        );
    }

    function record(): void {
        if (recording) {
            recorder.current?.stop();
            return;
        }
        if (!stream.current || typeof MediaRecorder === "undefined") {
            return setProblem(t("files.camera.failed"));
        }
        const chunks: Blob[] = [];
        const made = new MediaRecorder(stream.current);
        made.ondataavailable = (event) => chunks.push(event.data);
        made.onstop = () => {
            setRecording(false);
            const type = made.mimeType.split(";")[0] || "video/webm";
            const blob = new Blob(chunks, { type });
            if (blob.size === 0) return;
            onFiles([new File([blob], `video-${stamp()}.${EXTENSION[type] ?? "webm"}`, { type })]);
        };
        recorder.current = made;
        made.start();
        setRecording(true);
    }

    const chosen = (list: FileList | null) => {
        const files = [...(list ?? [])];
        if (files.length > 0) onFiles(files.slice(0, 1));
    };

    if (phone) {
        return (
            <div className="m-3 flex flex-1 flex-col items-center justify-center gap-2">
                {kinds.photo ? (
                    <Button className="w-full max-w-xs" onClick={() => photoInput.current?.click()}>
                        <Camera className="size-4 shrink-0" aria-hidden />
                        {t("files.camera.photo")}
                    </Button>
                ) : null}
                {kinds.video ? (
                    <Button
                        className="w-full max-w-xs"
                        variant="outline"
                        onClick={() => videoInput.current?.click()}
                    >
                        <Video className="size-4 shrink-0" aria-hidden />
                        {t("files.camera.video")}
                    </Button>
                ) : null}
                <Button
                    className="w-full max-w-xs"
                    variant="outline"
                    onClick={() => galleryInput.current?.click()}
                >
                    <Images className="size-4 shrink-0" aria-hidden />
                    {t("files.camera.gallery")}
                </Button>
                <input
                    ref={photoInput}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(event) => chosen(event.target.files)}
                />
                <input
                    ref={videoInput}
                    type="file"
                    accept="video/*"
                    capture="environment"
                    className="hidden"
                    onChange={(event) => chosen(event.target.files)}
                />
                <input
                    ref={galleryInput}
                    type="file"
                    accept={galleryAccept}
                    className="hidden"
                    onChange={(event) => chosen(event.target.files)}
                />
            </div>
        );
    }

    return (
        <div className="m-3 flex min-h-0 flex-1 flex-col gap-2">
            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-muted/40">
                <video
                    ref={video}
                    muted
                    playsInline
                    className="max-h-full max-w-full"
                    aria-label={t("files.camera.preview")}
                />
                {!live ? (
                    <span className="absolute px-4 text-center text-[13px] text-muted-foreground">
                        {problem || t("files.camera.starting")}
                    </span>
                ) : null}
            </div>
            {live && problem ? <p className="text-[12px] text-destructive">{problem}</p> : null}
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
                {kinds.photo ? (
                    <Button disabled={!live || recording} onClick={snap}>
                        <Camera className="size-4 shrink-0" aria-hidden />
                        {t("files.camera.photo")}
                    </Button>
                ) : null}
                {kinds.video ? (
                    <Button variant="outline" disabled={!live} onClick={record}>
                        {recording ? (
                            <Square className="size-4 shrink-0" aria-hidden />
                        ) : (
                            <Circle className="size-4 shrink-0 text-destructive" aria-hidden />
                        )}
                        {recording ? t("files.camera.stop") : t("files.camera.video")}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
