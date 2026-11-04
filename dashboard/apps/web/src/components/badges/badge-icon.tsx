/**
 * The drawn badge: a faceted medal whose colour climbs with the level, and a
 * glyph for what the badge is about. Original artwork, inline SVG, nothing
 * fetched. Locked levels draw the same shape in the neutral tone.
 */

import { cn } from "@polaris/ui";

/** Medal colours, lowest level first: copper, silver, gold, then the cool and bright tiers. */
const LEVEL_COLORS = [
    ["#b87333", "#8a4f1f"],
    ["#a7b1bc", "#6b7682"],
    ["#e2b33c", "#a87b12"],
    ["#2fb39c", "#1a7a69"],
    ["#3b82f6", "#1d4fb8"],
    ["#8b5cf6", "#5b34c2"],
    ["#e0508f", "#a12a62"],
    ["#f97316", "#7c3aed"]
] as const;

const STAFF_COLORS = ["#0ea5e9", "#0b4f8a"] as const;
const CUSTOM_COLORS = ["#14b8a6", "#0f6b62"] as const;
const LOCKED_COLORS = ["#9ca3af", "#6b7280"] as const;

/** One path per glyph, drawn on a 24 by 24 grid centred on the medal. */
const GLYPHS: Record<string, string> = {
    // An hourglass: time on the instance.
    tenure: "M8 5h8M8 19h8M9 5c0 4 6 4 6 7s-6 3-6 7M15 5c0 4-6 4-6 7s6 3 6 7",
    // A speech bubble with a tail.
    messages: "M6 7h12v8h-7l-3 3v-3H6z",
    // A sound wave: being on the call.
    calls: "M5 12h2M9 9v6M12 6v12M15 9v6M18 11v2",
    // A tick in a box.
    tasks: "M6 6h12v12H6zM9 12l2 2 4-4",
    // A cross pad and two buttons.
    arcade: "M7 10h2V8h2v2h2v2h-2v2H9v-2H7zM15 10.5h.01M17.5 12.5h.01",
    // A cube: a world on a server.
    servers: "M12 5l6 3.5v7L12 19l-6-3.5v-7zM6 8.5l6 3.5 6-3.5M12 12v7",
    // The north star.
    staff: "M12 4l1.6 6.4L20 12l-6.4 1.6L12 20l-1.6-6.4L4 12l6.4-1.6z",
    star: "M12 5l2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7L5.2 10l4.7-.7z",
    heart: "M12 18s-6-3.6-6-7.6A3.4 3.4 0 0 1 12 8a3.4 3.4 0 0 1 6 2.4c0 4-6 7.6-6 7.6z",
    shield: "M12 5l6 2v4.5c0 3.6-2.6 6.3-6 7.5-3.4-1.2-6-3.9-6-7.5V7z",
    flag: "M7 19V5M7 6h9l-2 3 2 3H7",
    bolt: "M13 4L7 13h4l-1 7 6-9h-4z",
    crown: "M5 16l1-8 4 4 2-5 2 5 4-4 1 8z",
    leaf: "M6 18c0-7 5-12 12-12 0 7-5 12-12 12zM6 18l6-6",
    gem: "M8 6h8l3 4-7 9-7-9zM5 10h14M10 6l-1 4 3 9 3-9-1-4"
};

export function badgeColors(
    kind: string,
    level: number,
    locked: boolean
): readonly [string, string] {
    if (locked) return LOCKED_COLORS;
    if (kind === "staff") return STAFF_COLORS;
    if (kind === "custom") return CUSTOM_COLORS;
    return LEVEL_COLORS[Math.max(0, Math.min(LEVEL_COLORS.length, level) - 1)] ?? LEVEL_COLORS[0];
}

export function BadgeIcon({
    icon,
    kind,
    level,
    locked = false,
    className
}: {
    icon: string;
    kind: string;
    level: number;
    locked?: boolean;
    className?: string;
}) {
    const [light, dark] = badgeColors(kind, level, locked);
    const id = `badge-${kind}-${icon}-${level}-${locked ? "l" : "u"}`;
    const glyph = GLYPHS[icon] ?? GLYPHS.star!;
    return (
        <svg
            viewBox="0 0 32 32"
            aria-hidden="true"
            className={cn("size-8 shrink-0", locked && "opacity-60", className)}
        >
            <defs>
                <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor={light} />
                    <stop offset="1" stopColor={dark} />
                </linearGradient>
            </defs>
            <path d="M16 1.5l12.5 7.25v14.5L16 30.5 3.5 23.25V8.75z" fill={`url(#${id})`} />
            <path
                d="M16 4.2l10.2 5.9v11.8L16 27.8 5.8 21.9V10.1z"
                fill="none"
                stroke="#ffffff"
                strokeOpacity="0.35"
                strokeWidth="1"
            />
            <g transform="translate(4 4)">
                <path
                    d={glyph}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </g>
        </svg>
    );
}
