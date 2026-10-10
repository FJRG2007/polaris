"use client";

/**
 * Small pieces the Sounds tab draws in several places: a level slider, and the
 * one player the screen listens through.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Where the screen reads one of the server's sounds from. The time it last
 *  changed is in the address, so a replaced file is not answered from cache. */
export function soundUrl(installedAppId: string, soundId: string, updatedAt: string): string {
    return `/api/apps/installed/${installedAppId}/minecraft/sounds/${soundId}?v=${encodeURIComponent(updatedAt)}`;
}

/** A volume or a pitch, as a slider with its value beside it. */
export function LevelSlider({
    label,
    value,
    min,
    max,
    step,
    disabled,
    onChange
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    disabled?: boolean;
    onChange: (value: number) => void;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="flex items-center justify-between gap-2 text-muted-foreground">
                <span className="truncate" title={label}>
                    {label}
                </span>
                <span className="tabular-nums">{value.toFixed(2)}</span>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                aria-label={label}
                onChange={(event) => onChange(Number(event.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
        </label>
    );
}

/**
 * One audio element for the whole screen: pressing Listen on another sound
 * stops the first. Pitch is played as the game plays it, by speed, so a 1.5 is
 * heard here as it will be heard in the game. `unplayable` is set when the
 * browser cannot play Ogg at all (Safari before 17).
 */
export function usePreview(): {
    playing: string | null;
    unplayable: boolean;
    play: (id: string, url: string, volume?: number, pitch?: number) => void;
    stop: () => void;
} {
    const audio = useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = useState<string | null>(null);
    const [unplayable, setUnplayable] = useState(false);

    const stop = useCallback(() => {
        audio.current?.pause();
        setPlaying(null);
    }, []);

    useEffect(() => () => audio.current?.pause(), []);

    const play = useCallback((id: string, url: string, volume = 1, pitch = 1) => {
        audio.current?.pause();
        const element = new Audio(url);
        audio.current = element;
        element.volume = Math.min(1, Math.max(0, volume));
        element.preservesPitch = false;
        element.playbackRate = pitch;
        element.onended = () => setPlaying((current) => (current === id ? null : current));
        setPlaying(id);
        element.play().catch((caught: unknown) => {
            setPlaying((current) => (current === id ? null : current));
            if (caught instanceof DOMException && caught.name === "NotSupportedError")
                setUnplayable(true);
        });
    }, []);

    return { playing, unplayable, play, stop };
}
