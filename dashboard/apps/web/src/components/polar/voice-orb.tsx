"use client";

/**
 * The orb voice mode is drawn around: it swells and wobbles with your voice
 * while Polar hears you, with Polar's own voice while it speaks, breathes while
 * it thinks, and sits still in another colour while it waits on you, is muted
 * or has failed. The level is read every frame from a function and written
 * straight to the elements' styles, so nothing re-renders per frame. With
 * reduced motion it neither moves nor scales: a ring brightens with the level.
 */

import { cn } from "@polaris/ui";
import { useEffect, useRef } from "react";

export type OrbState =
    | "listening"
    | "hearing"
    | "transcribing"
    | "thinking"
    | "speaking"
    | "approval"
    | "muted"
    | "error";

/** The colour token each state is drawn in. */
const TONE: Record<OrbState, string> = {
    listening: "--primary",
    hearing: "--primary",
    transcribing: "--primary",
    thinking: "--primary",
    speaking: "--primary",
    approval: "--warning",
    muted: "--muted-foreground",
    error: "--danger"
};

/** How far the level moves toward a new reading each frame: quick to rise,
 *  slower to fall, the way a voice meter reads naturally. */
const RISE = 0.35;
const FALL = 0.12;

export function VoiceOrb({
    state,
    level,
    className
}: {
    state: OrbState;
    /** The level to follow now, 0 to 1: the microphone or Polar's voice. */
    level: () => number;
    className?: string;
}) {
    const core = useRef<HTMLDivElement>(null);
    const glow = useRef<HTMLDivElement>(null);
    const ring = useRef<HTMLDivElement>(null);
    const current = useRef(state);
    current.current = state;
    const read = useRef(level);
    read.current = level;

    useEffect(() => {
        const reduced =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let smooth = 0;
        let frame = 0;
        let timer: ReturnType<typeof setInterval> | null = null;

        const target = (now: number): number => {
            switch (current.current) {
                case "hearing":
                case "listening":
                case "speaking":
                    return Math.min(1, Math.max(0, read.current()));
                case "thinking":
                case "transcribing":
                    // Breathing, about once every two seconds.
                    return 0.14 + 0.1 * Math.sin(now / 320);
                case "approval":
                    return 0.06 + 0.04 * Math.sin(now / 600);
                default:
                    return 0;
            }
        };

        const draw = (now: number) => {
            const goal = target(now);
            smooth += (goal - smooth) * (goal > smooth ? RISE : FALL);
            if (reduced) {
                if (ring.current) ring.current.style.opacity = String(0.25 + smooth * 0.75);
                return;
            }
            const wobble = smooth * 9;
            const radius = [0, 1.7, 3.1, 4.6]
                .map((offset) => `${50 + wobble * Math.sin(now / 260 + offset)}%`)
                .join(" ");
            if (core.current) {
                core.current.style.transform = `scale(${1 + smooth * 0.3}) rotate(${(now / 40) % 360}deg)`;
                core.current.style.borderRadius = radius;
            }
            if (glow.current) {
                glow.current.style.transform = `scale(${1 + smooth * 0.65})`;
                glow.current.style.opacity = String(0.3 + smooth * 0.55);
            }
        };

        if (reduced) {
            timer = setInterval(() => draw(Date.now()), 200);
        } else {
            const loop = (now: number) => {
                draw(now);
                frame = requestAnimationFrame(loop);
            };
            frame = requestAnimationFrame(loop);
        }
        return () => {
            cancelAnimationFrame(frame);
            if (timer) clearInterval(timer);
        };
    }, []);

    const tone = `hsl(var(${TONE[state]}))`;
    return (
        <div
            aria-hidden
            data-state={state}
            className={cn("relative grid size-24 shrink-0 place-items-center", className)}
        >
            <div
                ref={glow}
                className="absolute inset-2 rounded-full blur-xl transition-[background-color] duration-fast"
                style={{ backgroundColor: tone, opacity: 0.3 }}
            />
            <div
                ref={ring}
                className="absolute inset-1 rounded-full border-2 opacity-25 motion-safe:hidden"
                style={{ borderColor: tone }}
            />
            <div
                ref={core}
                className={cn(
                    "relative size-16 rounded-full shadow-sm transition-[background] duration-fast",
                    (state === "muted" || state === "error") && "opacity-70"
                )}
                style={{
                    background: `radial-gradient(circle at 35% 30%, color-mix(in oklab, ${tone} 45%, white), ${tone} 62%, color-mix(in oklab, ${tone} 70%, black))`
                }}
            />
        </div>
    );
}
