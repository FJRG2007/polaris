"use client";

/**
 * A video, opened.
 *
 * Over the conversation rather than inside it, which is what every messenger
 * settled on and for a reason worth stating: a video playing in a list is a
 * video the size of a message, next to the thing that scrolls it out of view.
 * The moment somebody presses play they have stopped reading and started
 * watching, and the screen should say so.
 *
 * The same shell as the picture viewer beside it - a dark ground, one press to
 * leave, escape to leave - so opening a clip and opening a photograph are the
 * same gesture with the same way out. The player inside is the one every screen
 * in Polaris uses, so the controls, the keyboard and the download are the ones
 * already learnt.
 */

import { X } from "lucide-react";
import { useEffect } from "react";
import { MediaPlayer } from "@/components/media-player";

export function VideoViewer({
    src,
    name,
    download,
    poster,
    onClose
}: {
    src: string;
    name?: string;
    download?: string;
    poster?: string;
    onClose: () => void;
}) {
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", key);
        // The page behind must not scroll under it: a wheel over a full-screen
        // viewer is somebody adjusting what they are watching, not moving the
        // conversation they have stopped reading.
        const overflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            window.removeEventListener("keydown", key);
            document.body.style.overflow = overflow;
        };
    }, [onClose]);

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={name ? `Watching ${name}` : "Watching a video"}
            // The ground closes it; the player does not. A press that landed on
            // the pause button must not also put the video away.
            onClick={onClose}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
        >
            <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close"
                className="absolute right-3 top-3 rounded-full bg-black/50 p-2 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
            >
                <X className="size-5" />
            </button>

            {name && (
                <p className="absolute left-4 top-4 max-w-[60vw] truncate text-sm text-white/80">
                    {name}
                </p>
            )}

            <div
                className="w-full max-w-5xl"
                onClick={(event) => event.stopPropagation()}
            >
                <MediaPlayer
                    autoPlay
                    kind="video"
                    src={src}
                    name={name}
                    poster={poster}
                    download={download}
                    // Opened on purpose, so it may fetch what it needs.
                    preload="auto"
                    // The video is the screen: space is play, and the arrows
                    // move through it. Nothing else here is listening, and
                    // without this the space bar scrolls the conversation
                    // underneath instead of pausing what is being watched.
                    keyboard="global"
                    className="overflow-hidden rounded-lg bg-black"
                />
            </div>
        </div>
    );
}
