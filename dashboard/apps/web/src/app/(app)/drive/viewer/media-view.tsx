"use client";

/** Audio and video playback through a Polaris-themed Plyr, loaded on demand. */

import "plyr/dist/plyr.css";
import { useEffect, useRef, type CSSProperties } from "react";

export function MediaView({ src, kind }: { src: string; kind: "video" | "audio" }) {
    const ref = useRef<HTMLMediaElement | null>(null);

    useEffect(() => {
        let player: { destroy(): void } | null = null;
        let active = true;
        void import("plyr").then((module) => {
            if (!active || !ref.current) return;
            const Plyr = module.default;
            player = new Plyr(ref.current, {
                controls: [
                    "play",
                    "progress",
                    "current-time",
                    "mute",
                    "volume",
                    "settings",
                    "fullscreen"
                ]
            });
        });
        return () => {
            active = false;
            player?.destroy();
        };
    }, [src]);

    const style = { "--plyr-color-main": "hsl(var(--primary))" } as CSSProperties;

    return (
        <div className="p-4" style={style}>
            {kind === "video" ? (
                <video
                    ref={(element) => {
                        ref.current = element;
                    }}
                    controls
                    playsInline
                    src={src}
                    className="w-full"
                />
            ) : (
                <audio
                    ref={(element) => {
                        ref.current = element;
                    }}
                    controls
                    src={src}
                    className="w-full"
                />
            )}
        </div>
    );
}
