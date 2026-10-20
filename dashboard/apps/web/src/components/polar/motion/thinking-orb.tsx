"use client";

/**
 * The thinking orb: a dotted, honestly 3D sphere whose motion says what Polar
 * is doing - nine states, each its own animation (see `orb-activity.ts` for
 * which one shows when). Two hand-tuned sizes, 64 beside an avatar and 20 in a
 * line of text; 32 is interpolated between them.
 *
 * Ported from thinking-orbs (github.com/Jakubantalik/Libraries.dev, MIT) - the
 * geometry and the tunings are the library's, verbatim, in `orb-engine/`.
 * Changed: the light or dark ink follows Polaris's theme tokens, the optional
 * tint is the `--primary` token, the label comes from the catalogue, and the
 * loop is the one every Polar animation shares (`motion-runtime.ts`). Under
 * `prefers-reduced-motion` it draws one still frame.
 */

import { cn } from "@polaris/ui";
import { useEffect, useRef } from "react";
import { paintFrame } from "./orb-engine/core";
import { MODE_FRAMES } from "./orb-engine/registry";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { resolvePreset, type OrbSize, type OrbState } from "./orb-engine/presets";
import {
    canvasRatio,
    prefersReducedMotion,
    runWhileVisible,
    themeIsDark,
    tokenRgb,
    useReducedMotion,
    useThemeVersion
} from "./motion-runtime";

/** The instant a still orb shows: far enough in for every state to read. */
export const STILL_AT = 0.6;

export function ThinkingOrb({
    state = "working",
    size = 64,
    speed = 1,
    paused = false,
    tone = "ink",
    label,
    className
}: {
    state?: OrbState;
    size?: OrbSize;
    /** A multiplier over the state's own tuned speed. */
    speed?: number;
    /** Hold the current frame. */
    paused?: boolean;
    /** Grey ink that follows the theme, or the theme's primary colour. */
    tone?: "ink" | "primary";
    /** Accessible name; the state's own words when absent. */
    label?: string;
    className?: string;
}) {
    const t = useTranslations("polar");
    const ref = useRef<HTMLCanvasElement | null>(null);
    const reduced = useReducedMotion();
    const theme = useThemeVersion();

    useEffect(() => {
        const canvas = ref.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const ratio = canvasRatio();
        canvas.width = Math.round(size * ratio);
        canvas.height = Math.round(size * ratio);
        const dark = themeIsDark(canvas);
        const tint = tone === "primary" ? (tokenRgb(canvas, "--primary") ?? undefined) : undefined;
        const { mode, speed: tuned, opts } = resolvePreset(state, size);
        const geometry = MODE_FRAMES[mode];
        const rate = tuned * speed;
        const draw = (seconds: number) => {
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.clearRect(0, 0, size, size);
            paintFrame(ctx, geometry(size, seconds, opts), dark, tint);
        };
        if (reduced || prefersReducedMotion()) {
            draw(STILL_AT);
            return;
        }
        if (paused) {
            draw((performance.now() / 1000) * rate);
            return;
        }
        return runWhileVisible(canvas, (seconds) => draw(seconds * rate));
    }, [state, size, speed, paused, tone, reduced, theme]);

    return (
        <canvas
            ref={ref}
            role="img"
            aria-label={label ?? t(`orb.${state}`)}
            data-orb-state={state}
            data-still={reduced ? "" : undefined}
            className={cn("block shrink-0", className)}
            style={{ width: size, height: size }}
        />
    );
}
