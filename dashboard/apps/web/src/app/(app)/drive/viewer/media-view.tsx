"use client";

/** Audio and video playback, through the player every screen in Polaris uses. */

import { MediaPlayer } from "@/components/media-player";

export function MediaView({
    src,
    kind,
    download
}: {
    src: string;
    kind: "video" | "audio";
    /** Where to save it from. The viewer's own chrome offers this too; the
     *  player carries it because somebody watching something is where the want
     *  arrives, not the toolbar above it. */
    download?: string;
}) {
    return <MediaPlayer src={src} kind={kind} download={download} className="p-4" />;
}
