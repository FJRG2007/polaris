"use client";

/**
 * Playing a voice message.
 *
 * A recording arriving as a grey chip saying `voice-message.webm` with a
 * download arrow is a file, not a message - somebody has to save it and open it
 * elsewhere to hear seven seconds of speech. So an audio attachment gets a
 * player: press, hear it, drag to the part that mattered.
 *
 * **The shape and the length come with the message, not from the file.** A
 * stream recorded in a browser carries no duration in its container - which is
 * why a seven-second message played back as `0:00` - and reading one out of the
 * file means downloading all of it to draw a number. Both were measured by the
 * browser that recorded it and stored on the attachment, so a conversation of
 * forty recordings draws forty waveforms and fetches nothing. `preload="none"`
 * keeps that true: bytes are asked for when somebody presses play.
 *
 * Anything with neither - a track somebody attached - falls back to asking the
 * file once it is playing.
 */

import { cn } from "@polaris/ui";
import { useAudioVolume } from "./audio-volume";
import { useEffect, useRef, useState } from "react";
import { barsOf, spokenLength } from "./voice-recorder";
import { Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger
} from "@polaris/ui";

/** What a bar shows when the level was nothing at all - a line, so the shape
 *  still reads as a strip of sound rather than a gap in one. */
const QUIETEST = 12;

/** How far an arrow key moves through a recording. Five seconds is a sentence,
 *  which is the unit people actually skip in. */
const STEP_SECONDS = 5;

/**
 * The speeds, in the order the button walks through them.
 *
 * The same three every messenger settled on, and for the reason everybody who
 * has been sent a four-minute recording knows: at one and a half you still hear
 * every word, and at two you find out whether it needed four minutes.
 */
const SPEEDS = [1, 1.5, 2] as const;

/** Where the choice is kept. Per browser, and it carries to the next recording -
 *  somebody who speeds one up is telling you how they want to be read to, not
 *  making a decision about one file. */
const SPEED_KEY = "polaris.voice.speed";

function rememberedSpeed(): number {
    if (typeof window === "undefined") return 1;
    try {
        const stored = Number(window.localStorage.getItem(SPEED_KEY));
        return SPEEDS.includes(stored as (typeof SPEEDS)[number]) ? stored : 1;
    } catch {
        return 1;
    }
}

export function VoiceNote({
    href,
    name,
    /** False for a music file somebody attached, which keeps its name above the
     *  player - a recording has no name worth showing. */
    recorded,
    durationMs,
    waveform
}: {
    href: string;
    name: string;
    recorded: boolean;
    durationMs: number | null;
    waveform: string | null;
}) {
    const audio = useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [at, setAt] = useState(0);
    const [measured, setMeasured] = useState(0);
    const [broken, setBroken] = useState("");
    // Read from storage after mount rather than during render: the server has no
    // local storage, and a button that said "2x" only after hydration would
    // change under somebody's finger.
    const [speed, setSpeed] = useState(1);
    useEffect(() => setSpeed(rememberedSpeed()), []);
    /** How loud every recording in every conversation plays. One level rather
     *  than one per message: somebody turning this down is saying how loud the
     *  room should be. */
    const [volume, setVolume] = useAudioVolume();

    // What was stored wins: it was measured while recording, and the file itself
    // may never admit to a duration at all.
    const length = durationMs && durationMs > 0 ? durationMs / 1000 : measured;
    const bars = barsOf(waveform);

    useEffect(() => {
        const element = audio.current;
        if (!element) return;
        const onTime = () => setAt(element.currentTime);
        const onLength = () => {
            // A browser-made stream reads as Infinity until it has been played
            // through, so anything that is not a real number is not an answer.
            if (Number.isFinite(element.duration)) setMeasured(element.duration);
        };
        /**
         * Ask why, rather than shrugging.
         *
         * An `<audio>` element cannot read a response body, so a recording that
         * will not play is only ever "no supported source" from in here. One
         * request on failure - and only on failure - gets the server's own
         * answer, which is the difference between a player that is broken and a
         * storage that lost the file.
         */
        const onBroken = () => {
            setPlaying(false);
            setBroken("This recording could not be loaded.");
            void fetch(href)
                .then(async (response) => {
                    if (response.ok) return;
                    const said: unknown = await response.json().catch(() => null);
                    const body = (said ?? {}) as { error?: unknown; detail?: unknown };
                    const sentence = typeof body.error === "string" ? body.error : "";
                    // The second half is only ever sent to an administrator, and
                    // is the part that names the disk.
                    const detail = typeof body.detail === "string" ? body.detail : "";
                    if (sentence) setBroken(detail ? `${sentence} ${detail}` : sentence);
                })
                .catch(() => undefined);
        };
        const onEnd = () => {
            setPlaying(false);
            setAt(0);
            // A browser-made stream admits its duration once it has been played
            // to the end. Worth taking for the recordings made before Polaris
            // measured them itself, and it costs nothing: the bytes are already
            // here.
            if (Number.isFinite(element.duration)) setMeasured(element.duration);
        };
        element.addEventListener("timeupdate", onTime);
        element.addEventListener("loadedmetadata", onLength);
        element.addEventListener("durationchange", onLength);
        element.addEventListener("ended", onEnd);
        element.addEventListener("error", onBroken);
        return () => {
            element.removeEventListener("timeupdate", onTime);
            element.removeEventListener("loadedmetadata", onLength);
            element.removeEventListener("durationchange", onLength);
            element.removeEventListener("ended", onEnd);
            element.removeEventListener("error", onBroken);
        };
    }, []);

    // Set on the element rather than only at play: changing it mid-sentence is
    // the whole point of the button.
    useEffect(() => {
        if (audio.current) audio.current.playbackRate = speed;
    }, [speed]);

    // The same, for the level. Applied to every player on the screen at once,
    // because they all read the one setting - a level that took effect on the
    // next message rather than on the one being listened to would be a control
    // nobody trusts.
    useEffect(() => {
        if (audio.current) audio.current.volume = volume;
    }, [volume]);

    const faster = () => {
        const next = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length] ?? 1;
        setSpeed(next);
        try {
            window.localStorage.setItem(SPEED_KEY, String(next));
        } catch {
            // A browser with storage switched off still plays at the speed it
            // was given; it just forgets by the next message.
        }
    };

    const toggle = () => {
        const element = audio.current;
        if (!element) return;
        setBroken("");
        if (element.paused) {
            element.playbackRate = speed;
            element.volume = volume;
            void element.play().then(() => setPlaying(true));
        } else {
            element.pause();
            setPlaying(false);
        }
    };

    /** Where a press on the waveform lands, as a fraction of the whole. */
    const seekTo = (fraction: number) => {
        const element = audio.current;
        if (!element || length <= 0) return;
        const wanted = Math.max(0, Math.min(1, fraction)) * length;
        element.currentTime = wanted;
        setAt(wanted);
    };

    /** The same, from a pointer somewhere over the shape. */
    const seekToPointer = (clientX: number, shape: HTMLElement) => {
        const box = shape.getBoundingClientRect();
        seekTo((clientX - box.left) / box.width);
    };

    /** Whether the pointer is down on the shape, which is what turns a press into
     *  a scrub. Held in a ref rather than in state: it changes on every frame of
     *  a drag, and nothing on screen is drawn from it. */
    const scrubbing = useRef(false);

    const done = length > 0 ? Math.min(1, at / length) : 0;

    return (
        <span className="inline-flex max-w-full flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5">
            {!recorded && (
                <span
                    className="max-w-[16rem] truncate text-[11px] text-muted-foreground"
                    title={name}
                >
                    {name}
                </span>
            )}
            {/* Said rather than left as a play button that does nothing. The
                bytes live on whatever storage this instance writes uploads to,
                and "the NAS is not answering" looks exactly like a broken
                player from here. */}
            {broken && <span className="text-[11px] text-danger">{broken}</span>}
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

                {bars.length > 0 ? (
                    // The shape is the control. Every player people already use
                    // lets you press into the middle of a sentence and then drag
                    // along it to find the word, and a waveform that only took a
                    // press would be half of one.
                    //
                    // The pointer is captured on the way down, so the drag keeps
                    // working past the ends of the shape and past the edge of the
                    // message - letting go anywhere finishes it, which is what
                    // stops a scrub getting stuck on a fast movement.
                    <button
                        type="button"
                        aria-label="Skip to a point in this message"
                        onPointerDown={(event) => {
                            scrubbing.current = true;
                            event.currentTarget.setPointerCapture(event.pointerId);
                            seekToPointer(event.clientX, event.currentTarget);
                        }}
                        onPointerMove={(event) => {
                            if (!scrubbing.current) return;
                            seekToPointer(event.clientX, event.currentTarget);
                        }}
                        onPointerUp={() => {
                            scrubbing.current = false;
                        }}
                        onPointerCancel={() => {
                            scrubbing.current = false;
                        }}
                        onKeyDown={(event) => {
                            const way =
                                event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
                            if (!way || length <= 0) return;
                            event.preventDefault();
                            seekTo((at + way * STEP_SECONDS) / length);
                        }}
                        // Nothing selects and nothing scrolls under the finger:
                        // a drag along a waveform on a phone is a drag along a
                        // waveform, not a scroll of the conversation.
                        className="flex h-7 w-44 max-w-[45vw] shrink-0 touch-none select-none items-end gap-px"
                    >
                        {bars.map((level, index) => (
                            <span
                                key={index}
                                style={{ height: `${QUIETEST + (level / 9) * (100 - QUIETEST)}%` }}
                                className={cn(
                                    "w-full min-w-px rounded-full transition-colors",
                                    index / bars.length <= done ? "bg-primary" : "bg-border"
                                )}
                            />
                        ))}
                    </button>
                ) : (
                    <input
                        type="range"
                        min={0}
                        max={length || 0}
                        step={0.05}
                        value={at}
                        disabled={length === 0}
                        aria-label="Position"
                        onChange={(event) => seekTo(Number(event.target.value) / (length || 1))}
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
                )}

                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {length > 0 ? spokenLength(length - at) : spokenLength(at)}
                </span>

                <button
                    type="button"
                    onClick={faster}
                    aria-label={`Playing at ${speed} times speed. Press to change.`}
                    title="Playback speed"
                    className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-card-hover"
                >
                    {speed}x
                </button>

                {/* How loud the recordings in this conversation are, on the
                    thing being listened to. Behind a press rather than always on
                    screen: it is set once and then never again, and a slider on
                    every message would be a slider on forty messages. */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            aria-label={`Volume, ${Math.round(volume * 100)} per cent`}
                            title="Volume"
                            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
                        >
                            {volume === 0 ? (
                                <VolumeX className="size-3.5" />
                            ) : volume < 0.5 ? (
                                <Volume1 className="size-3.5" />
                            ) : (
                                <Volume2 className="size-3.5" />
                            )}
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="top" className="w-56 p-3">
                        <span className="flex items-center justify-between gap-2 pb-2 text-xs">
                            <span className="font-medium text-foreground-subtle">
                                Recordings volume
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                                {Math.round(volume * 100)}%
                            </span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={Math.round(volume * 100)}
                            aria-label="Recordings volume"
                            onChange={(event) => setVolume(Number(event.target.value) / 100)}
                            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary"
                        />
                        <p className="pt-2 text-[11px] text-muted-foreground">
                            Every recording in every conversation, on this device.
                        </p>
                    </DropdownMenuContent>
                </DropdownMenu>
            </span>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- somebody's voice, with no transcript to caption it */}
            <audio ref={audio} src={href} preload="none" />
        </span>
    );
}
