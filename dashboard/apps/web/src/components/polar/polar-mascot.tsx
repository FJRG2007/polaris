/**
 * Polar, the assistant's mascot: a polar bear's face with a star on its brow.
 *
 * Ported from the approved design with every animation it has - breathing,
 * blinking, the ears, the star's twinkle and its spin while thinking, the eyes
 * looking around, the mouth talking, the hop when something is done and the
 * shake on trouble. `prefers-reduced-motion` stops all of it. The colours are
 * Polar's own identity and stay fixed in both themes.
 */

export const POLAR_MOODS = [
    "idle",
    "thinking",
    "listening",
    "speaking",
    "done",
    "trouble"
] as const;
export type PolarMood = (typeof POLAR_MOODS)[number];

const STYLE = `
@keyframes polar-spin{to{transform:rotate(90deg)}}
@keyframes polar-wave{0%,100%{opacity:.25}50%{opacity:1}}
@keyframes polar-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-0.6px) scale(1.012)}}
@keyframes polar-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(0.1)}}
@keyframes polar-ear-l{0%,80%,100%{transform:rotate(0)}84%{transform:rotate(-14deg)}88%{transform:rotate(4deg)}92%{transform:rotate(0)}}
@keyframes polar-ear-r{0%,60%,100%{transform:rotate(0)}64%{transform:rotate(14deg)}68%{transform:rotate(-4deg)}72%{transform:rotate(0)}}
@keyframes polar-twinkle{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.18);opacity:.85}}
@keyframes polar-hop{0%,100%{transform:translateY(0)}30%{transform:translateY(-4px)}55%{transform:translateY(0)}70%{transform:translateY(-1.5px)}}
@keyframes polar-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-1.6px)}40%{transform:translateX(1.6px)}60%{transform:translateX(-1px)}80%{transform:translateX(1px)}}
@keyframes polar-talk{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}
@keyframes polar-look{0%,100%{transform:translate(0,0)}25%{transform:translate(1.2px,-0.4px)}60%{transform:translate(-1.2px,-0.4px)}}
.polar-star-spin{transform-box:view-box;transform-origin:32px 24.5px;animation:polar-spin 1.4s cubic-bezier(.6,0,.4,1) infinite}
.polar-wave-a{animation:polar-wave 1.2s ease-in-out infinite}
.polar-wave-b{animation:polar-wave 1.2s ease-in-out .3s infinite}
.polar-body{transform-box:view-box;transform-origin:32px 56px}
.m-idle .polar-body,.m-listening .polar-body,.m-speaking .polar-body{animation:polar-breathe 3.2s ease-in-out infinite}
.m-done .polar-body{animation:polar-hop 1.1s ease-out 2}
.m-trouble .polar-body{animation:polar-shake .5s ease-in-out 2}
.polar-eyes{transform-box:view-box;transform-origin:32px 35px;animation:polar-blink 4.6s ease-in-out infinite}
.m-thinking .polar-look{transform-box:view-box;animation:polar-look 2.4s ease-in-out infinite}
.polar-ear-l{transform-box:view-box;transform-origin:19px 24px;animation:polar-ear-l 7s ease-in-out infinite}
.polar-ear-r{transform-box:view-box;transform-origin:45px 24px;animation:polar-ear-r 9s ease-in-out infinite}
.m-listening .polar-ear-l,.m-listening .polar-ear-r{animation-duration:2.2s}
.polar-twinkle{transform-box:view-box;transform-origin:32px 24.5px;animation:polar-twinkle 2.8s ease-in-out infinite}
.polar-talk{transform-box:view-box;transform-origin:32px 46.4px;animation:polar-talk .32s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.polar-star-spin,.polar-wave-a,.polar-wave-b,.polar-body,.polar-eyes,.polar-look,.polar-ear-l,.polar-ear-r,.polar-twinkle,.polar-talk{animation:none!important}}
`;

// Polar's identity colours, fixed in every theme like a logo's.
const VIOLET = "#7E4FEE";
const FUR = "#F4F6FB";
const INK = "#161A24";
const EAR = "#C9B8FA";
const MUZZLE = "#E3E7F1";
const WAVE = "#9B78F5";

export function PolarMascot({
    mood = "idle",
    size = 24,
    plate = false,
    label
}: {
    mood?: PolarMood;
    size?: number;
    plate?: boolean;
    /** Accessible name; decorative (hidden) when absent. */
    label?: string;
}) {
    const on = (moods: PolarMood[]) => (moods.includes(mood) ? 1 : 0);
    return (
        <svg
            className={`m-${mood} shrink-0`}
            width={size}
            height={size}
            viewBox="0 0 64 64"
            role={label ? "img" : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
        >
            <style>{STYLE}</style>
            {plate ? <rect x="0" y="0" width="64" height="64" rx="15" fill={VIOLET} /> : null}
            <g transform={plate ? "translate(6.4 7) scale(0.8)" : undefined}>
                <g className="polar-body">
                    <g className="polar-ear-l">
                        <circle
                            cx="15"
                            cy="19"
                            r="7.5"
                            fill={FUR}
                            stroke={INK}
                            strokeOpacity="0.14"
                        />
                        <circle cx="15" cy="19" r="3.8" fill={EAR} />
                    </g>
                    <g className="polar-ear-r">
                        <circle
                            cx="49"
                            cy="19"
                            r="7.5"
                            fill={FUR}
                            stroke={INK}
                            strokeOpacity="0.14"
                        />
                        <circle cx="49" cy="19" r="3.8" fill={EAR} />
                    </g>
                    <ellipse
                        cx="32"
                        cy="37"
                        rx="22.5"
                        ry="19.5"
                        fill={FUR}
                        stroke={INK}
                        strokeOpacity="0.14"
                    />
                    <g opacity={mood === "trouble" ? 0.4 : 1}>
                        <g
                            className={
                                mood === "idle" || mood === "done" ? "polar-twinkle" : undefined
                            }
                        >
                            <path
                                className={mood === "thinking" ? "polar-star-spin" : undefined}
                                d="M32 19 Q32 24.5 37.5 24.5 Q32 24.5 32 30 Q32 24.5 26.5 24.5 Q32 24.5 32 19 Z"
                                fill={VIOLET}
                            />
                        </g>
                    </g>
                    <ellipse cx="32" cy="44.5" rx="9.5" ry="7" fill={MUZZLE} />
                    <ellipse cx="32" cy="40.8" rx="3.4" ry="2.4" fill={INK} />
                    <g className="polar-look">
                        <g className="polar-eyes">
                            <g opacity={on(["idle", "listening", "speaking"])}>
                                <circle cx="23.5" cy="35" r="2.6" fill={INK} />
                                <circle cx="40.5" cy="35" r="2.6" fill={INK} />
                                <circle cx="24.4" cy="34.1" r="0.85" fill="#FFFFFF" />
                                <circle cx="41.4" cy="34.1" r="0.85" fill="#FFFFFF" />
                            </g>
                            <g opacity={on(["thinking"])}>
                                <circle cx="24.6" cy="33.4" r="2.4" fill={INK} />
                                <circle cx="41.6" cy="33.4" r="2.4" fill={INK} />
                                <circle cx="25.4" cy="32.6" r="0.8" fill="#FFFFFF" />
                                <circle cx="42.4" cy="32.6" r="0.8" fill="#FFFFFF" />
                            </g>
                        </g>
                    </g>
                    <g
                        opacity={on(["done"])}
                        fill="none"
                        stroke={INK}
                        strokeWidth="1.9"
                        strokeLinecap="round"
                    >
                        <path d="M20.8 35.8 Q23.5 32.4 26.2 35.8" />
                        <path d="M37.8 35.8 Q40.5 32.4 43.2 35.8" />
                    </g>
                    <g opacity={on(["trouble"])}>
                        <circle cx="23.5" cy="35.4" r="2.3" fill={INK} />
                        <circle cx="40.5" cy="35.4" r="2.3" fill={INK} />
                        <path
                            d="M20.4 30.6 L25.6 29.4 M43.6 30.6 L38.4 29.4"
                            fill="none"
                            stroke={INK}
                            strokeWidth="1.6"
                            strokeLinecap="round"
                        />
                    </g>
                    <g fill="none" stroke={INK} strokeWidth="1.6" strokeLinecap="round">
                        <path
                            opacity={on(["idle", "listening"])}
                            d="M32 43.2 V45.4 M29.4 45.4 Q32 47.8 34.6 45.4"
                        />
                        <path opacity={on(["thinking"])} d="M32 43.2 V45.6 M30 46.4 H34" />
                        <path opacity={on(["done"])} d="M32 43.2 V45 M28.6 45 Q32 49.4 35.4 45" />
                        <path
                            opacity={on(["trouble"])}
                            d="M32 43.2 V45.2 M29.4 47.6 Q32 45.4 34.6 47.6"
                        />
                    </g>
                    <ellipse
                        className={mood === "speaking" ? "polar-talk" : undefined}
                        opacity={on(["speaking"])}
                        cx="32"
                        cy="46.4"
                        rx="2.7"
                        ry="2.2"
                        fill={INK}
                    />
                    <g
                        opacity={on(["listening", "speaking"])}
                        fill="none"
                        stroke={WAVE}
                        strokeWidth="2"
                        strokeLinecap="round"
                    >
                        <path className="polar-wave-a" d="M57 31 Q59.5 35 57 39" />
                        <path className="polar-wave-b" d="M60.5 28 Q64.5 35 60.5 42" />
                    </g>
                </g>
            </g>
        </svg>
    );
}
