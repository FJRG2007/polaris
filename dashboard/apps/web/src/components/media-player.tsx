"use client";

/**
 * The player Polaris draws for a recording, wherever one is played.
 *
 * Plyr rather than the browser's own controls, and one component rather than one
 * per screen. Native controls are a different shape and a different set of
 * affordances in every browser - Safari's have no speed control, Firefox's put
 * the fullscreen button somewhere else - so a product that uses them looks
 * borrowed and behaves differently depending on where it is opened. This is one
 * set of controls, in Polaris' own colour, everywhere: a clip in a conversation,
 * a recording in Drive, a camera's footage, and the preview of something that
 * has not been sent yet.
 *
 * Loaded on demand: the player is a couple of hundred kilobytes and most screens
 * never draw one, so it is imported when an element actually exists rather than
 * bundled into every page that might.
 *
 * Two things it does that the raw element does not:
 *
 * - **It offers the file.** A player with no way to save what it is playing
 *   sends people to a context menu that Polaris has replaced. Where the caller
 *   passes an address to save from, the control is there.
 * - **It repairs a duration nobody wrote down.** Anything a browser recorded -
 *   a voice message, a screen clip - comes out of MediaRecorder with no duration
 *   in its container, so the counter reads `00:-2` and the bar refuses to seek:
 *   the player cannot know where the end is. Seeking past the end once makes the
 *   browser work it out, and from then on both behave.
 *
 * What this deliberately does NOT cover:
 *
 * - a live camera. There is nothing to seek and no duration to draw, the picture
 *   has its own controls over it, and the stream is swapped between transports by
 *   re-creating the element - which is exactly what a player wrapped around it
 *   would fight.
 * - a call. Those are `MediaStream` tiles, not files somebody plays.
 * - a voice message, which is a waveform and a play button on purpose: what a
 *   recording sounds like is the thing worth drawing.
 */

import "plyr/dist/plyr.css";
import { cn } from "@polaris/ui";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/** The controls every player in Polaris carries. Download is added by the caller
 *  passing somewhere to download from - what may be saved is the screen's
 *  decision, not the player's. */
const CONTROLS = [
    "play-large",
    "play",
    "progress",
    "current-time",
    "mute",
    "volume",
    "settings",
    "fullscreen"
];

/**
 * Teach the browser where the end is.
 *
 * A file a browser recorded carries no duration: MediaRecorder writes the
 * container header before it knows how long the recording will be, and never
 * goes back to fix it. The element reports `Infinity`, the counter subtracts
 * from it and prints nonsense, and the seek bar has nothing to map a position
 * onto - dragging it snaps back, which reads as a broken player.
 *
 * The way out is the one every player uses: ask to seek somewhere no recording
 * reaches. The browser walks to the end to answer, learns the real duration on
 * the way, and reports it - after which everything works normally. Done once,
 * and put back to where it was, so nobody sees it happen.
 *
 * Needs the file to be seekable at all, which for anything served by Polaris
 * means the route has to answer a range request. It does; see the attachment
 * route.
 */
function repairDuration(media: HTMLMediaElement): () => void {
    let repairing = false;

    const settle = () => {
        if (repairing || Number.isFinite(media.duration)) return;
        repairing = true;
        const at = media.currentTime;
        const done = () => {
            media.removeEventListener("durationchange", done);
            // Back where they were, and never past the end - a repaired duration
            // with the head parked on it is a player that looks finished before
            // it has started.
            media.currentTime = Number.isFinite(at) ? at : 0;
            repairing = false;
        };
        media.addEventListener("durationchange", done);
        try {
            media.currentTime = 1e101;
        } catch {
            // A source that refuses to seek at all: nothing to repair, and the
            // player is no worse off than it was.
            done();
        }
    };

    media.addEventListener("loadedmetadata", settle);
    if (media.readyState >= 1) settle();
    return () => media.removeEventListener("loadedmetadata", settle);
}

export function MediaPlayer({
    src,
    kind,
    name,
    autoPlay = false,
    download,
    poster,
    preload = "metadata",
    className,
    onClick
}: {
    src: string;
    kind: "video" | "audio";
    /**
     * What the file is called.
     *
     * Put on the element rather than drawn, because that is where the menu over
     * it looks: a right-click on a video asks the DOM what it is about, and an
     * address ending in a uuid is not a name anybody wants a download called.
     */
    name?: string;
    autoPlay?: boolean;
    /**
     * Where to save it from, when the screen allows saving it.
     *
     * Its own address rather than `src`, because they are rarely the same: what
     * is played is served to be played, and what is saved is served as a file
     * to save - see the `?download=1` the attachment route answers to.
     */
    download?: string;
    /** A still to show before anything is fetched. */
    poster?: string;
    /**
     * How much to fetch before somebody presses play.
     *
     * `metadata` by default: enough to know how long it is and to draw the bar,
     * and not the file. `none` for a player that is only mounted once somebody
     * has decided to watch - see `VideoPreview`, which is what a list of
     * messages uses so that opening a conversation full of clips downloads none
     * of them.
     */
    preload?: "none" | "metadata" | "auto";
    /** Put on the frame around the player, since the element itself is wrapped
     *  by Plyr and hidden behind its own chrome. */
    className?: string;
    /** For a player drawn inside something that is itself pressable - a clip in a
     *  list that opens on click - so pressing play does not also open it. */
    onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
}): ReactNode {
    const element = useRef<HTMLMediaElement | null>(null);

    useEffect(() => {
        let player: { destroy(): void } | null = null;
        let active = true;
        const media = element.current;
        const stopRepair = media ? repairDuration(media) : () => undefined;

        void import("plyr")
            .then((module) => {
                if (!active || !element.current) return;
                const Plyr = module.default;
                player = new Plyr(element.current, {
                    controls: download ? [...CONTROLS, "download"] : CONTROLS,
                    // Nothing is stored about what somebody watched: this is a
                    // file on their own instance.
                    storage: { enabled: false },
                    // The keys, while the player has the focus. Never globally -
                    // space is how a page scrolls, and a player halfway down a
                    // list of clips must not take it.
                    keyboard: { focused: true, global: false },
                    // Where the download button points. Cast because the option
                    // is older than the types shipped beside it: the library
                    // reads `urls.download` and always has, and passing it any
                    // other way means reaching into the rendered button.
                    ...(download ? ({ urls: { download } } as object) : {})
                });
            })
            .catch(() => {
                // The chunk did not load, or this browser gave the player
                // something it could not work with. The element underneath still
                // has `controls` on it, so what is left is the browser's own
                // player rather than a rectangle that does nothing.
            });
        return () => {
            active = false;
            stopRepair();
            // Destroyed rather than left to the garbage collector: Plyr binds to
            // the document for fullscreen and keyboard, and a player left behind
            // by a closed dialog keeps answering them.
            player?.destroy();
        };
    }, [src, kind, download]);

    // Plyr's own accent, pointed at the token rather than a hex, so it follows
    // the theme like everything else.
    const style = { "--plyr-color-main": "hsl(var(--primary))" } as CSSProperties;

    return (
        <div className={cn("w-full", className)} style={style} onClick={onClick}>
            {kind === "video" ? (
                <video
                    ref={(node) => {
                        element.current = node;
                    }}
                    // Keyed on the source so a new one really is a new element:
                    // Plyr is built against the element it was given, and handing
                    // that element a different file underneath it leaves the
                    // controls describing the previous one.
                    key={src}
                    src={src}
                    data-name={name}
                    poster={poster}
                    preload={preload}
                    controls
                    playsInline
                    autoPlay={autoPlay}
                    className="w-full"
                />
            ) : (
                <audio
                    ref={(node) => {
                        element.current = node;
                    }}
                    key={src}
                    src={src}
                    preload={preload}
                    controls
                    autoPlay={autoPlay}
                    className="w-full"
                />
            )}
        </div>
    );
}
