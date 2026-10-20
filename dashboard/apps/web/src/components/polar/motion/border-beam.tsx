"use client";

/**
 * A beam of light running round the edge of what it wraps - the composer while
 * Polar streams an answer. It fades in when `active` turns on, finishes its
 * lap fading out when it turns off, and takes the corner radius of its child.
 *
 * Ported from border-beam's bordered variant (github.com/Jakubantalik/
 * Libraries.dev, MIT): the same three layers (a masked stroke, an inner glow
 * near the edges, a blurred bloom), the same conic stops, 1.96 s lap and 12 s
 * hue drift. Changed: the colour patches are the theme's `--primary` and
 * `--ring` tokens instead of a fixed rainbow, the light/dark ink follows the
 * tokens, and under `prefers-reduced-motion` there is no beam at all.
 */

import { cn } from "@polaris/ui";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { themeIsDark, useReducedMotion, useThemeVersion } from "./motion-runtime";

/** One lap, in seconds, and the hue drift either side of the token's own. */
export const BEAM_LAP = 1.96;
const HUE_RANGE = 30;

// The library's colour patches: where each sits and how big it is. Its fixed
// colours become the theme's two accent tokens, alternating.
const PATCHES: Array<{ pos: string; size: [number, number] }> = [
    { pos: "33% -7.4%", size: [70, 40] },
    { pos: "12% -5%", size: [60, 35] },
    { pos: "2.1% 68.3%", size: [40, 70] },
    { pos: "2.1% 68.3%", size: [20, 35] },
    { pos: "74.4% 100%", size: [180, 32] },
    { pos: "55% 100%", size: [85, 26] },
    { pos: "93.9% 0%", size: [74, 32] },
    { pos: "100% 27.1%", size: [26, 42] },
    { pos: "100% 27.1%", size: [52, 48] }
];

const TONE = {
    dark: {
        stroke: 0.26,
        inner: 0.42,
        bloom: 0.24,
        shadow: "rgba(255, 255, 255, 0.27)",
        saturation: 1.2,
        ink: "255, 255, 255",
        line: [0.1, 0.3, 0.6, 0.75],
        glow: [0.03, 0.08, 0.2, 0.45, 0.85]
    },
    light: {
        stroke: 0.12,
        inner: 0.26,
        bloom: 0.34,
        shadow: "rgba(0, 0, 0, 0.14)",
        saturation: 1.5,
        ink: "0, 0, 0",
        line: [0.08, 0.2, 0.4, 0.55],
        glow: [0.02, 0.08, 0.2, 0.4, 0.6]
    }
} as const;

const MASK = (angle: string) => `conic-gradient(from var(${angle}),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%)`;

/** The stylesheet for one beam, scoped to `[data-beam="<id>"]`. Pure. */
export function beamCss(id: string, radius: number, dark: boolean): string {
    const tone = dark ? TONE.dark : TONE.light;
    const angle = `--beam-angle-${id}`;
    const opacity = `--beam-opacity-${id}`;
    const inner = Math.max(0, radius - 1);
    const [l1, l2, l3, l4] = tone.line;
    const [g1, g2, g3, g4, g5] = tone.glow;
    const ink = (alpha: number) => `rgba(${tone.ink}, ${alpha})`;
    const token = (index: number) => (index % 2 === 0 ? "var(--primary)" : "var(--ring)");
    const patches = (scale: number, alpha: number) =>
        PATCHES.map(
            (patch, index) =>
                `radial-gradient(ellipse ${Math.round(patch.size[0] * scale)}px ${Math.round(
                    patch.size[1] * scale
                )}px at ${patch.pos}, hsl(${token(index)} / ${alpha}), transparent)`
        ).join(",\n    ");
    const line = `conic-gradient(from var(${angle}),
        transparent 0%, transparent 54%, ${ink(l1)} 57%, ${ink(l2)} 60%, ${ink(l3)} 63%,
        ${ink(l4)} 66%, ${ink(l3)} 69%, ${ink(l2)} 72%, ${ink(l1)} 75%, transparent 78%, transparent 100%)`;
    const bloom = `conic-gradient(from var(${angle}),
        transparent 0%, transparent 58%, ${ink(g1)} 62%, ${ink(g2)} 65%, ${ink(g3)} 67%,
        ${ink(g4)} 69%, ${ink(g5)} 70%, ${ink(g5)} 70.5%, ${ink(g4)} 71.5%, ${ink(g3)} 73%,
        ${ink(g2)} 75%, ${ink(g1)} 78%, transparent 82%)`;
    const filter = (shift: number) =>
        `hue-rotate(${shift}deg) brightness(1.30) saturate(${tone.saturation.toFixed(2)})`;
    const scope = `[data-beam="${id}"]`;
    return `
@property ${angle} { syntax: "<angle>"; initial-value: 0deg; inherits: true; }
@property ${opacity} { syntax: "<number>"; initial-value: 0; inherits: true; }
${scope} { position: relative; border-radius: ${radius}px; }
${scope}[data-active] { animation: beam-spin-${id} ${BEAM_LAP}s linear infinite, beam-in-${id} 0.6s ease forwards; }
${scope}[data-fading] { animation: beam-spin-${id} ${BEAM_LAP}s linear infinite, beam-out-${id} 0.5s ease forwards; }
${scope}[data-active]::after, ${scope}[data-fading]::after {
  content: ""; position: absolute; inset: 0; border-radius: ${inner}px; padding: 1px;
  clip-path: inset(0 round ${radius}px);
  background: ${line},
    ${patches(1, 1)};
  -webkit-mask: ${MASK(angle)}, linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: source-in, xor;
  mask: ${MASK(angle)}, linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: intersect, exclude;
  pointer-events: none; z-index: 2;
  opacity: calc(var(${opacity}) * ${tone.stroke});
  animation: beam-hue-${id} 12s ease-in-out infinite;
}
${scope}[data-active]::before, ${scope}[data-fading]::before {
  content: ""; position: absolute; inset: 0; border-radius: ${radius}px;
  background: ${patches(0.9, 0.45)};
  box-shadow: inset 0 0 9px 1px ${tone.shadow};
  -webkit-mask-image: ${MASK(angle)},
    linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white),
    linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white);
  -webkit-mask-composite: source-in, source-over;
  mask-image: ${MASK(angle)},
    linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white),
    linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white);
  mask-composite: intersect, add;
  pointer-events: none; z-index: 1;
  opacity: calc(var(${opacity}) * ${tone.inner});
  clip-path: inset(0 round ${radius}px);
  animation: beam-hue-${id} 12s ease-in-out infinite;
}
${scope} > [data-beam-bloom] { display: none; }
${scope}[data-active] > [data-beam-bloom], ${scope}[data-fading] > [data-beam-bloom] {
  display: block; position: absolute; inset: 0; border-radius: ${inner}px; padding: 1px;
  clip-path: inset(0 round ${radius}px);
  background: ${bloom};
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  filter: blur(8px) brightness(1.30) saturate(${tone.saturation.toFixed(2)});
  pointer-events: none; z-index: 3;
  opacity: calc(var(${opacity}) * ${tone.bloom});
}
${scope}[data-paused], ${scope}[data-paused]::after, ${scope}[data-paused]::before {
  animation-play-state: paused !important;
}
@keyframes beam-spin-${id} { to { ${angle}: 360deg; } }
@keyframes beam-in-${id} { to { ${opacity}: 1; } }
@keyframes beam-out-${id} { from { ${opacity}: 1; } to { ${opacity}: 0; } }
@keyframes beam-hue-${id} {
  0%, 100% { filter: ${filter(-HUE_RANGE)}; }
  50% { filter: ${filter(HUE_RANGE)}; }
}`;
}

export function BorderBeam({
    active,
    children,
    className
}: {
    active: boolean;
    /** One element; its corner radius becomes the beam's. */
    children: ReactNode;
    className?: string;
}) {
    const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
    const ref = useRef<HTMLDivElement | null>(null);
    const reduced = useReducedMotion();
    const theme = useThemeVersion();
    const [phase, setPhase] = useState<"off" | "on" | "fading">(active ? "on" : "off");
    const [radius, setRadius] = useState(8);
    const [dark, setDark] = useState(true);
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        setPhase((current) => (active ? "on" : current === "on" ? "fading" : current));
    }, [active]);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        setDark(themeIsDark(el));
        const child = el.firstElementChild;
        const raw = child ? parseFloat(getComputedStyle(child).borderTopLeftRadius) : NaN;
        if (raw > 0) setRadius(raw);
    }, [theme, active]);

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const shown = !reduced && phase !== "off";
    return (
        <div
            ref={ref}
            data-beam={id}
            data-active={shown && phase === "on" ? "" : undefined}
            data-fading={shown && phase === "fading" ? "" : undefined}
            data-paused={shown && !visible ? "" : undefined}
            className={cn("relative", className)}
            onAnimationEnd={(event) => {
                if (event.animationName === `beam-out-${id}`) setPhase("off");
            }}
        >
            {children}
            {shown ? (
                <>
                    <style>{beamCss(id, radius, dark)}</style>
                    <span data-beam-bloom="" aria-hidden />
                </>
            ) : null}
        </div>
    );
}
