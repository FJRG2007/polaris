"use client";

/** Audio and video playback, through the player every screen in Polaris uses. */

import { MediaPlayer } from "@/components/media-player";

export function MediaView({ src, kind }: { src: string; kind: "video" | "audio" }) {
    return <MediaPlayer src={src} kind={kind} className="p-4" />;
}
