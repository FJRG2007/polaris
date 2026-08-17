"use client";

/**
 * One camera, big.
 *
 * The wall is for taking in the whole house at a glance; this is for looking at
 * something. So it swaps to the good stream rather than the small one the tiles
 * watch, gives the picture the whole dialog, and puts the controls where they
 * belong on a video: over it, and out of the way until the pointer is there.
 *
 * Fullscreen is the browser's own, on the frame rather than the video element,
 * so the controls stay on screen with it - a fullscreen `<video>` hides
 * everything drawn over it.
 */

import { PtzPad } from "./ptz-pad";
import { useEffect, useRef, useState } from "react";
import type { CameraView } from "@/lib/home/cameras";
import { Camera, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogTitle, cn } from "@polaris/ui";

export function CameraViewer({
    camera,
    canControl,
    onClose
}: {
    camera: CameraView;
    canControl: boolean;
    onClose: () => void;
}) {
    const frame = useRef<HTMLDivElement | null>(null);
    const video = useRef<HTMLVideoElement | null>(null);
    const [full, setFull] = useState(false);
    const [failed, setFailed] = useState(false);
    const [ready, setReady] = useState(false);

    // The browser is the authority on whether it is fullscreen: it leaves on
    // Escape without telling anybody who asked for it.
    useEffect(() => {
        const sync = () => setFull(document.fullscreenElement === frame.current);
        document.addEventListener("fullscreenchange", sync);
        return () => document.removeEventListener("fullscreenchange", sync);
    }, []);

    // Closing has to end the request rather than hide it: a stream left running
    // holds a slot on the relay for a camera nobody is watching.
    useEffect(() => {
        const element = video.current;
        return () => {
            if (!element) return;
            element.pause();
            element.removeAttribute("src");
            element.load();
        };
    }, []);

    const toggleFullscreen = () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void frame.current?.requestFullscreen().catch(() => setFull(false));
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-5xl p-0" showClose={!full}>
                <DialogTitle className="sr-only">{camera.name}</DialogTitle>
                <div ref={frame} className="group/frame relative bg-black">
                    <video
                        ref={video}
                        src={`/api/home/cameras/${camera.id}/stream?q=main`}
                        className={cn("w-full bg-black", full ? "h-screen object-contain" : "aspect-video object-contain")}
                        autoPlay
                        muted
                        playsInline
                        controls={false}
                        onCanPlay={() => setReady(true)}
                        onError={() => setFailed(true)}
                    />

                    {!ready && !failed ? (
                        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/70">
                            <Loader2 className="size-6 shrink-0 animate-spin" />
                        </span>
                    ) : null}
                    {failed ? (
                        <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/70">
                            <Camera className="size-6 shrink-0" />
                            <span className="text-[12px]">This camera is not answering</span>
                        </span>
                    ) : null}

                    {/* Over the picture, and faded until somebody is actually
                        looking for them - a live view with a bar of chrome across
                        it is a smaller live view. */}
                    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent p-3 opacity-0 transition-opacity group-hover/frame:opacity-100">
                        <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-white" title={camera.name}>{camera.name}</p>
                            {camera.zone ? <p className="truncate text-[11px] text-white/70" title={camera.zone}>{camera.zone}</p> : null}
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={full ? "Leave fullscreen" : "Fullscreen"}
                            title={full ? "Leave fullscreen" : "Fullscreen"}
                            className="pointer-events-auto text-white/80 hover:bg-white/15 hover:text-white"
                            onClick={toggleFullscreen}
                        >
                            {full ? (
                                <Minimize2 className="size-4 shrink-0" />
                            ) : (
                                <Maximize2 className="size-4 shrink-0" />
                            )}
                        </Button>
                    </div>

                    {camera.ptz && canControl ? <PtzPad cameraId={camera.id} /> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}
