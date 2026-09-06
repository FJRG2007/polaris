"use client";

/**
 * Audio and video playback, through the player every screen in Polaris uses.
 *
 * A video is also a picture somebody wants a closer look at - a frame of a
 * recording, something in the corner of a clip - so the wheel pushes into it and
 * it can be dragged, the same gesture the camera viewer and a shared screen in a
 * call answer to. Only the picture moves: the player's own controls sit outside
 * the transform, so a zoomed video is still a video somebody can pause.
 *
 * Audio has no picture, and the gestures are simply not attached to it.
 */

import { cn } from "@polaris/ui";
import { useZoomPan } from "@/components/use-zoom-pan";
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
    const look = useZoomPan();
    if (kind === "audio") {
        return <MediaPlayer src={src} kind={kind} download={download} className="p-4" />;
    }
    return (
        <div
            ref={look.frameRef}
            {...look.frameProps}
            className={cn(
                "relative size-full overflow-hidden",
                look.zoomed && "cursor-grab active:cursor-grabbing"
            )}
        >
            <div
                className="size-full origin-center will-change-transform"
                style={{ transform: look.transform }}
            >
                <MediaPlayer src={src} kind={kind} download={download} className="p-4" />
            </div>
            {/* Only once the wheel has been used: a button that says 1.0x says
                nothing, and a control over a video that nobody has touched is
                one more thing between somebody and the picture. */}
            {look.zoomed && (
                <button
                    type="button"
                    onClick={look.reset}
                    aria-label="Fit the video again"
                    title="Fit the video again"
                    className="absolute right-3 top-3 rounded bg-background/80 px-1.5 py-1 text-[0.6875rem] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
                >
                    {look.zoom.scale.toFixed(1)}x
                </button>
            )}
        </div>
    );
}
