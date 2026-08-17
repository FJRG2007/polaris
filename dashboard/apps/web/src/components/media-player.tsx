"use client";

/**
 * The player Polaris draws for a recording, wherever one is played.
 *
 * Plyr rather than the browser's own controls, and one component rather than one
 * per screen. Native controls are a different shape and a different set of
 * affordances in every browser - Safari's have no speed control, Firefox's put
 * the fullscreen button somewhere else - so a product that uses them looks
 * borrowed and behaves differently depending on where it is opened. This is one
 * set of controls, in Polaris' own colour, everywhere.
 *
 * Loaded on demand: the player is a couple of hundred kilobytes and most screens
 * never draw one, so it is imported when an element actually exists rather than
 * bundled into every page that might.
 *
 * What this deliberately does NOT cover:
 *
 * - a live camera. There is nothing to seek and no duration to draw, the picture
 *   has its own controls over it, and the stream is swapped between transports by
 *   re-creating the element - which is exactly what a player wrapped around it
 *   would fight.
 * - a call. Those are `MediaStream` tiles, not files somebody plays.
 * - a voice message, which is a waveform and a play button on purpose: what a
 *   recording sounds like is the thing worth drawing, and a browser recording
 *   carries no duration for a seek bar to use.
 */

import "plyr/dist/plyr.css";
import { cn } from "@polaris/ui";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/** The controls, in one place so every player in Polaris carries the same ones.
 *  No download button: what may be saved is decided by the screen around this,
 *  not by the player. */
const CONTROLS = ["play-large", "play", "progress", "current-time", "mute", "volume", "settings", "fullscreen"];

export function MediaPlayer({
    src,
    kind,
    autoPlay = false,
    className,
    onClick
}: {
    src: string;
    kind: "video" | "audio";
    autoPlay?: boolean;
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
        void import("plyr")
            .then((module) => {
                if (!active || !element.current) return;
                const Plyr = module.default;
                player = new Plyr(element.current, {
                    controls: CONTROLS,
                    // Nothing is stored about what somebody watched: this is a
                    // file on their own instance.
                    storage: { enabled: false },
                    // The keys, while the player has the focus. Never globally -
                    // space is how a page scrolls, and a player halfway down a
                    // list of clips must not take it.
                    keyboard: { focused: true, global: false }
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
            // Destroyed rather than left to the garbage collector: Plyr binds to
            // the document for fullscreen and keyboard, and a player left behind
            // by a closed dialog keeps answering them.
            player?.destroy();
        };
    }, [src, kind]);

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
                    controls
                    autoPlay={autoPlay}
                    className="w-full"
                />
            )}
        </div>
    );
}
