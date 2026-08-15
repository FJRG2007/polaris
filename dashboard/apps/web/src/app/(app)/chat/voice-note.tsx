"use client";

/**
 * Playing a voice message.
 *
 * A recording arriving as a grey chip saying `voice-message.webm` with a
 * download arrow is a file, not a message - somebody has to save it and open it
 * elsewhere to hear seven seconds of speech. So an audio attachment gets a
 * player: press, hear it, scrub back to the part that mattered.
 *
 * Nothing is loaded until it is played. `preload="none"` means a conversation
 * with forty recordings in it costs forty rows of markup and no bytes, and the
 * bytes still come through Polaris' own authorized route rather than from
 * anywhere else.
 */

import { cn } from "@polaris/ui";
import { Pause, Play } from "lucide-react";
import { spokenLength } from "./voice-recorder";
import { useEffect, useRef, useState } from "react";

export function VoiceNote({
    href,
    name,
    /** False for a music file somebody attached, which keeps its name above the
     *  player - a recording has no name worth showing. */
    recorded
}: {
    href: string;
    name: string;
    recorded: boolean;
}) {
    const audio = useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [at, setAt] = useState(0);
    const [length, setLength] = useState(0);

    useEffect(() => {
        const element = audio.current;
        if (!element) return;
        const onTime = () => setAt(element.currentTime);
        const onLength = () => {
            // A stream recorded in the browser often has no duration in it until
            // it has been played through, and reads as Infinity until then.
            setLength(Number.isFinite(element.duration) ? element.duration : 0);
        };
        const onEnd = () => {
            setPlaying(false);
            setAt(0);
        };
        element.addEventListener("timeupdate", onTime);
        element.addEventListener("loadedmetadata", onLength);
        element.addEventListener("durationchange", onLength);
        element.addEventListener("ended", onEnd);
        return () => {
            element.removeEventListener("timeupdate", onTime);
            element.removeEventListener("loadedmetadata", onLength);
            element.removeEventListener("durationchange", onLength);
            element.removeEventListener("ended", onEnd);
        };
    }, []);

    const toggle = () => {
        const element = audio.current;
        if (!element) return;
        if (element.paused) {
            void element.play().then(() => setPlaying(true));
        } else {
            element.pause();
            setPlaying(false);
        }
    };

    const done = length > 0 ? Math.min(1, at / length) : 0;

    return (
        <span className="inline-flex max-w-full flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5">
            {!recorded && (
                <span className="max-w-[16rem] truncate text-[11px] text-muted-foreground" title={name}>
                    {name}
                </span>
            )}
            <span className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={toggle}
                    aria-label={playing ? "Pause" : "Play this message"}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105"
                >
                    {playing ? (
                        <Pause className="size-4 fill-current" />
                    ) : (
                        <Play className="size-4 fill-current" />
                    )}
                </button>

                {/* The bar is the control, not a picture of one: a voice message
                    is the one attachment people routinely need to hear twice. */}
                <input
                    type="range"
                    min={0}
                    max={length || 0}
                    step={0.05}
                    value={at}
                    disabled={length === 0}
                    aria-label="Position"
                    onChange={(event) => {
                        const element = audio.current;
                        if (!element) return;
                        element.currentTime = Number(event.target.value);
                        setAt(element.currentTime);
                    }}
                    style={{ backgroundSize: `${done * 100}% 100%` }}
                    className={cn(
                        "h-1 w-40 max-w-[45vw] cursor-pointer appearance-none rounded-full bg-muted",
                        "bg-gradient-to-r from-primary to-primary bg-no-repeat",
                        "[&::-webkit-slider-thumb]:size-2.5 [&::-webkit-slider-thumb]:appearance-none",
                        "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary",
                        "[&::-moz-range-thumb]:size-2.5 [&::-moz-range-thumb]:border-0",
                        "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary"
                    )}
                />

                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {length > 0 ? spokenLength(length - at) : spokenLength(at)}
                </span>
            </span>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- somebody's voice, with no transcript to caption it */}
            <audio ref={audio} src={href} preload="none" />
        </span>
    );
}
