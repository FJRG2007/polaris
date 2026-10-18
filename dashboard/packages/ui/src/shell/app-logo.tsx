"use client";

/**
 * Each Polaris app's own logo - the one place they are drawn.
 *
 * The launcher used to show the same purple tile with a grey line glyph for
 * every app, so a grid of sixteen read as sixteen copies of one thing. Each app
 * here has a glyph of its own in a colour of its own, drawn to one standard so
 * the set still looks like one family:
 *
 * - one 32-unit canvas with the glyph kept inside 4..28, so every logo has the
 *   same optical size and margin;
 * - soft geometry: corners rounded at 3-7 units, line details at 2.6-3.4 units,
 *   nothing thinner, so the glyph survives being drawn at 16px;
 * - two layers per glyph: a `base` filled with the app's three-stop gradient,
 *   and a lighter `face` from the gradient's first two stops, both running
 *   top-left to bottom-right; white cut-in details sit inside a filled shape
 *   so they never land on the page itself;
 * - mid-to-deep stops only, so a logo holds its shape on a light page and on a
 *   dark one alike.
 *
 * Hues are spread so that apps next to each other in the default launcher
 * order never share a colour family. A logo is decorative - the app's name is
 * always written beside it - so it is hidden from assistive technology.
 */

import { useId, type ReactNode } from "react";

/** An app's gradient, lightest stop first. */
export type AppLogoPalette = readonly [string, string, string];

interface LogoDefinition {
    readonly palette: AppLogoPalette;
    /** The glyph, given the fills for its two layers and a mask id it may use. */
    readonly draw: (fill: { base: string; face: string; mask: string }) => ReactNode;
}

const WHITE = "#fff";

/** Line details drawn in white over a filled shape. */
const LINE = {
    fill: "none",
    stroke: WHITE,
    strokeWidth: 3,
    strokeLinecap: "round",
    strokeLinejoin: "round"
} as const;

/**
 * The single source of truth: app id -> logo. Keyed by the ids the app
 * registry uses (`home` is Places, `games` is Game servers, `admin` is
 * Management), so an app keeps its logo whatever it is called on screen.
 */
const LOGOS: Readonly<Record<string, LogoDefinition>> = {
    // A dashboard: four panels of two sizes.
    overview: {
        palette: ["#A5B4FC", "#6366F1", "#4338CA"],
        draw: ({ base, face }) => (
            <>
                <rect x="4" y="4" width="11" height="14" rx="3.5" fill={base} />
                <rect x="17" y="14" width="11" height="14" rx="3.5" fill={base} />
                <rect x="17" y="4" width="11" height="8" rx="3.5" fill={face} />
                <rect x="4" y="20" width="11" height="8" rx="3.5" fill={face} />
            </>
        )
    },
    // A folder, its front panel lighter than its back.
    drive: {
        palette: ["#FCD34D", "#F59E0B", "#EA580C"],
        draw: ({ base, face }) => (
            <>
                <path
                    d="M4 9.5A3.5 3.5 0 0 1 7.5 6h4.9a3 3 0 0 1 2.1.9L16.6 9h7.9A3.5 3.5 0 0 1 28 12.5v11a3.5 3.5 0 0 1-3.5 3.5h-17A3.5 3.5 0 0 1 4 23.5z"
                    fill={base}
                />
                <path
                    d="M4 16a3.5 3.5 0 0 1 3.5-3.5h17A3.5 3.5 0 0 1 28 16v7.5a3.5 3.5 0 0 1-3.5 3.5h-17A3.5 3.5 0 0 1 4 23.5z"
                    fill={face}
                />
            </>
        )
    },
    // A shield with a keyhole, its left half catching the light.
    vault: {
        palette: ["#5EEAD4", "#14B8A6", "#0F766E"],
        draw: ({ base, face }) => (
            <>
                <path
                    d="M14.9 3.9a3 3 0 0 1 2.2 0l7.9 3A3 3 0 0 1 27 9.7v5.8c0 6.1-4.2 11.2-10.2 12.9a3 3 0 0 1-1.6 0C9.2 26.7 5 21.6 5 15.5V9.7a3 3 0 0 1 2-2.8z"
                    fill={base}
                />
                <path
                    d="M16 3.7v24.8a3 3 0 0 1-.8-.1C9.2 26.7 5 21.6 5 15.5V9.7a3 3 0 0 1 2-2.8l7.9-3a3 3 0 0 1 1.1-.2z"
                    fill={face}
                />
                <circle cx="16" cy="13.5" r="3" fill={WHITE} />
                <rect x="14.6" y="14" width="2.8" height="7.5" rx="1.4" fill={WHITE} />
            </>
        )
    },
    // Three tiles and a fourth on its way in: the apps you add.
    apps: {
        palette: ["#F0ABFC", "#C026D3", "#7E22CE"],
        draw: ({ base, face }) => (
            <>
                <rect x="4" y="4" width="11" height="11" rx="3.5" fill={base} />
                <rect x="4" y="17" width="11" height="11" rx="3.5" fill={base} />
                <rect x="17" y="17" width="11" height="11" rx="3.5" fill={base} />
                <circle cx="22.5" cy="9.5" r="5.5" fill={face} />
            </>
        )
    },
    // Places: a house with a lit window and a door.
    home: {
        palette: ["#7DD3FC", "#0EA5E9", "#1D4ED8"],
        draw: ({ base, face }) => (
            <>
                <path
                    d="M4.5 14.3a3 3 0 0 1 1.1-2.3l8.5-7.1a3 3 0 0 1 3.8 0l8.5 7.1a3 3 0 0 1 1.1 2.3V24a3 3 0 0 1-3 3h-17a3 3 0 0 1-3-3z"
                    fill={base}
                />
                <path
                    d="M4.5 14.3a3 3 0 0 1 1.1-2.3l8.5-7.1a3 3 0 0 1 3.8 0l8.5 7.1a3 3 0 0 1 1.1 2.3v.9H4.5z"
                    fill={face}
                />
                <path d="M12.5 27v-5a3.5 3.5 0 0 1 7 0v5z" fill={WHITE} />
            </>
        )
    },
    // A wrench: a light head with its jaw cut out, on a deeper handle.
    tools: {
        palette: ["#D9F99D", "#65A30D", "#15803D"],
        draw: ({ base, face, mask }) => (
            <>
                <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
                    <rect width="32" height="32" fill={WHITE} />
                    <rect
                        x="13.6"
                        y="0"
                        width="4.8"
                        height="9.5"
                        rx="1.6"
                        fill="#000"
                        transform="rotate(45 16 16)"
                    />
                </mask>
                <g transform="rotate(45 16 16)">
                    <rect x="13" y="13" width="6" height="16" rx="3" fill={base} />
                </g>
                <g mask={`url(#${mask})`}>
                    <circle cx="20.24" cy="11.76" r="7.5" fill={face} />
                </g>
            </>
        )
    },
    // A game controller with its pad and buttons.
    games: {
        palette: ["#FDA4AF", "#F43F5E", "#BE123C"],
        draw: ({ base }) => (
            <>
                <path
                    d="M10 8.5h12a6.5 6.5 0 0 1 6.4 5.3l1.2 6.4a3.8 3.8 0 0 1-6.6 3.2L20.6 21h-9.2L9 23.4a3.8 3.8 0 0 1-6.6-3.2l1.2-6.4A6.5 6.5 0 0 1 10 8.5z"
                    fill={base}
                />
                <path d="M10.5 12.3v5.4M7.8 15h5.4" {...LINE} strokeWidth={2.6} />
                <circle cx="21.2" cy="13.2" r="1.7" fill={WHITE} />
                <circle cx="23.8" cy="16.8" r="1.7" fill={WHITE} />
            </>
        )
    },
    // A ticked box.
    tasks: {
        palette: ["#86EFAC", "#22C55E", "#15803D"],
        draw: ({ base, face }) => (
            <>
                <rect x="4" y="4" width="24" height="24" rx="7" fill={base} />
                <path d="M4 11a7 7 0 0 1 7-7h10a7 7 0 0 1 7 7v1H4z" fill={face} opacity="0.55" />
                <path d="M10.5 16.5l3.8 3.8 7.4-8" {...LINE} strokeWidth={3.4} />
            </>
        )
    },
    // A speech bubble mid-sentence.
    chat: {
        palette: ["#FDBA74", "#F97316", "#C2410C"],
        draw: ({ base }) => (
            <>
                <path
                    d="M16 5c6.6 0 12 4.6 12 10.2s-5.4 10.2-12 10.2c-1.5 0-2.9-.2-4.2-.7l-5.2 2.6c-.9.4-1.8-.4-1.5-1.3l1.3-3.9C4.9 20.3 4 17.9 4 15.2 4 9.6 9.4 5 16 5z"
                    fill={base}
                />
                <circle cx="10.8" cy="15.2" r="1.8" fill={WHITE} />
                <circle cx="16" cy="15.2" r="1.8" fill={WHITE} />
                <circle cx="21.2" cy="15.2" r="1.8" fill={WHITE} />
            </>
        )
    },
    // An envelope with its flap folded in.
    mail: {
        palette: ["#C4B5FD", "#8B5CF6", "#6D28D9"],
        draw: ({ base, face }) => (
            <>
                <rect x="3.5" y="7" width="25" height="18.5" rx="4" fill={base} />
                <path
                    d="M4.1 8.9A4 4 0 0 1 7.5 7h17a4 4 0 0 1 3.4 1.9l-9.8 8.4a3.3 3.3 0 0 1-4.2 0z"
                    fill={face}
                />
            </>
        )
    },
    // A calendar page: rings, a header, and the days.
    calendar: {
        palette: ["#FCA5A5", "#EF4444", "#B91C1C"],
        draw: ({ base, face }) => (
            <>
                <rect x="4" y="6" width="24" height="22" rx="5" fill={base} />
                <path d="M4 11a5 5 0 0 1 5-5h14a5 5 0 0 1 5 5v2.5H4z" fill={face} />
                <rect x="9.5" y="3" width="3" height="6.5" rx="1.5" fill={base} />
                <rect x="19.5" y="3" width="3" height="6.5" rx="1.5" fill={base} />
                <circle cx="10.5" cy="18.5" r="1.7" fill={WHITE} />
                <circle cx="16" cy="18.5" r="1.7" fill={WHITE} />
                <circle cx="21.5" cy="18.5" r="1.7" fill={WHITE} />
                <circle cx="10.5" cy="23.2" r="1.7" fill={WHITE} />
                <circle cx="16" cy="23.2" r="1.7" fill={WHITE} />
            </>
        )
    },
    // Two people: the contact in front of the relationship behind.
    crm: {
        palette: ["#A5F3FC", "#06B6D4", "#0E7490"],
        draw: ({ base, face }) => (
            <>
                <circle cx="21" cy="10" r="4.5" fill={base} />
                <path
                    d="M14 25a7.5 7 0 0 1 14 0v.8a1.7 1.7 0 0 1-1.7 1.7h-10.6A1.7 1.7 0 0 1 14 25.8z"
                    fill={base}
                />
                <circle cx="12" cy="12" r="5" fill={face} />
                <path
                    d="M3.5 26.2a8.5 8 0 0 1 17 0 1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z"
                    fill={face}
                />
            </>
        )
    },
    // A status page: a header and a row of uptime bars.
    "status-pages": {
        palette: ["#6EE7B7", "#10B981", "#047857"],
        draw: ({ base, face }) => (
            <>
                <rect x="4" y="5" width="24" height="22" rx="5" fill={base} />
                <path d="M4 10a5 5 0 0 1 5-5h14a5 5 0 0 1 5 5v1.5H4z" fill={face} />
                <rect x="8.2" y="15" width="2.8" height="8" rx="1.4" fill={WHITE} />
                <rect x="12.7" y="15" width="2.8" height="8" rx="1.4" fill={WHITE} />
                <rect x="17.2" y="15" width="2.8" height="8" rx="1.4" fill={WHITE} />
                <rect x="21.7" y="18" width="2.8" height="5" rx="1.4" fill={WHITE} />
            </>
        )
    },
    // A trigger wired to the step it starts.
    automations: {
        palette: ["#5EEAD4", "#0D9488", "#115E59"],
        draw: ({ base, face }) => (
            <>
                <rect x="4" y="5" width="11" height="9" rx="3" fill={base} />
                <rect x="17" y="18" width="11" height="9" rx="3" fill={face} />
                <path d="M15 9.5h3.5a3 3 0 0 1 3 3V18" {...LINE} strokeWidth={2.6} />
            </>
        )
    },
    // A sticky note with a turned-up corner and two lines.
    notes: {
        palette: ["#FDE68A", "#EAB308", "#B45309"],
        draw: ({ base, face }) => (
            <>
                <path
                    d="M5 9a4 4 0 0 1 4-4h14a4 4 0 0 1 4 4v9.5L18.5 27H9a4 4 0 0 1-4-4z"
                    fill={base}
                />
                <path d="M27 18.5h-5.5a3 3 0 0 0-3 3V27z" fill={face} />
                <path d="M10.5 11.5h11M10.5 16.5h6.5" {...LINE} strokeWidth={2.8} />
            </>
        )
    },
    // Two documents, the open one in front.
    office: {
        palette: ["#93C5FD", "#3B82F6", "#1E3A8A"],
        draw: ({ base, face }) => (
            <>
                <rect x="11" y="4" width="17" height="20" rx="3.5" fill={base} />
                <rect x="4" y="8.5" width="17" height="19.5" rx="3.5" fill={face} />
                <path d="M8.5 15h8M8.5 19.5h8M8.5 24h4.5" {...LINE} strokeWidth={2.4} />
            </>
        )
    },
    // A server box in front of a cloud.
    "cloud-servers": {
        palette: ["#D8B4FE", "#A855F7", "#6B21A8"],
        draw: ({ base, face }) => (
            <>
                <circle cx="11" cy="14" r="5" fill={base} />
                <circle cx="17.5" cy="11.5" r="6.5" fill={base} />
                <circle cx="23" cy="15.5" r="4.5" fill={base} />
                <rect x="6" y="14" width="21.5" height="6" rx="3" fill={base} />
                <rect x="9" y="18" width="14" height="10" rx="3" fill={face} />
                <path d="M12.5 23h7" {...LINE} strokeWidth={2.6} />
            </>
        )
    },
    // A pulse inside a dial: something is being watched.
    watch: {
        palette: ["#F9A8D4", "#EC4899", "#9D174D"],
        draw: ({ base }) => (
            <>
                <circle cx="16" cy="16" r="12.5" fill={base} />
                <path d="M7.8 16.5h3.6l2.4-5 4.4 10 2.4-5h3.6" {...LINE} strokeWidth={2.8} />
            </>
        )
    },
    // A magnifying glass with a tick in its lens: a scan that came back.
    "security-scans": {
        palette: ["#FCD34D", "#D97706", "#92400E"],
        draw: ({ base, face }) => (
            <>
                <g transform="rotate(-45 13.5 13.5)">
                    <rect x="11.3" y="20" width="4.4" height="9.5" rx="2.2" fill={base} />
                </g>
                <circle cx="13.5" cy="13.5" r="9" fill={base} />
                <circle cx="13.5" cy="13.5" r="6" fill={face} />
                <path d="M10.6 13.8l2 2 3.9-4.3" {...LINE} strokeWidth={2.6} />
            </>
        )
    },
    // The Ad blocker: a lookup refused - a no-entry sign over the network.
    "dns-blocker": {
        palette: ["#FCA5A5", "#DC2626", "#7F1D1D"],
        draw: ({ base, face }) => (
            <>
                <circle cx="16" cy="16" r="12.5" fill={base} />
                <circle cx="16" cy="16" r="8.5" fill={face} />
                <path d="M10.6 21.4l10.8-10.8" {...LINE} strokeWidth={3.2} />
            </>
        )
    },
    // Management: three sliders set to different values.
    admin: {
        palette: ["#CBD5E1", "#64748B", "#334155"],
        draw: ({ base, face }) => (
            <>
                <rect x="4" y="7.3" width="24" height="3.4" rx="1.7" fill={base} />
                <rect x="4" y="14.3" width="24" height="3.4" rx="1.7" fill={base} />
                <rect x="4" y="21.3" width="24" height="3.4" rx="1.7" fill={base} />
                <circle cx="11" cy="9" r="4" fill={face} />
                <circle cx="21" cy="16" r="4" fill={face} />
                <circle cx="14" cy="23" r="4" fill={face} />
                <circle cx="11" cy="9" r="1.5" fill={WHITE} />
                <circle cx="21" cy="16" r="1.5" fill={WHITE} />
                <circle cx="14" cy="23" r="1.5" fill={WHITE} />
            </>
        )
    },
    // My account: one person.
    account: {
        palette: ["#99F6E4", "#2DD4BF", "#0F766E"],
        draw: ({ base, face }) => (
            <>
                <circle cx="16" cy="10.5" r="6" fill={face} />
                <path
                    d="M5 26a11 9.5 0 0 1 22 0v.3a1.7 1.7 0 0 1-1.7 1.7H6.7A1.7 1.7 0 0 1 5 26.3z"
                    fill={base}
                />
            </>
        )
    }
};

/** Every app id that has a logo, in the registry's order. */
export const APP_LOGO_IDS: readonly string[] = Object.keys(LOGOS);

/** Whether this app has a logo of its own; one that does not keeps its icon. */
export function hasAppLogo(appId: string): boolean {
    return Object.hasOwn(LOGOS, appId);
}

/** The app's gradient, or null for an app without a logo. */
export function appLogoPalette(appId: string): AppLogoPalette | null {
    return hasAppLogo(appId) ? LOGOS[appId]!.palette : null;
}

/**
 * The logo for one app. An id without one draws `fallback` instead (nothing by
 * default), so every surface renders an app through this one component and an
 * installed app without a logo keeps its icon.
 *
 * Gradient and mask ids come from `useId`, so two copies of one logo on a page
 * (the launcher's trigger and its grid) never resolve each other's fills.
 */
export function AppLogo({
    appId,
    size = 24,
    className,
    fallback = null
}: {
    appId: string;
    /** Rendered width and height in pixels. */
    size?: number;
    className?: string;
    /** Drawn in the logo's place for an app without one. */
    fallback?: ReactNode;
}) {
    // `useId` returns characters (colons, guillemets) that a `url(#...)`
    // reference does not resolve reliably; keep the letters and digits.
    const uid = `al${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
    const logo = hasAppLogo(appId) ? LOGOS[appId]! : null;
    if (!logo) return <>{fallback}</>;
    const [light, mid, deep] = logo.palette;
    const ids = { base: `${uid}b`, face: `${uid}f`, mask: `${uid}m` };

    return (
        <svg
            viewBox="0 0 32 32"
            width={size}
            height={size}
            aria-hidden="true"
            focusable="false"
            className={className}
            data-app-logo={appId}
            // Inline, so a container's own icon rule (a menu item sizes every svg
            // in it to 16px) never shrinks a logo drawn at another size.
            style={{ width: size, height: size, flexShrink: 0 }}
        >
            <defs>
                <linearGradient
                    id={ids.base}
                    x1="4"
                    y1="4"
                    x2="28"
                    y2="28"
                    gradientUnits="userSpaceOnUse"
                >
                    <stop offset="0" stopColor={light} />
                    <stop offset="0.55" stopColor={mid} />
                    <stop offset="1" stopColor={deep} />
                </linearGradient>
                <linearGradient
                    id={ids.face}
                    x1="4"
                    y1="4"
                    x2="28"
                    y2="28"
                    gradientUnits="userSpaceOnUse"
                >
                    <stop offset="0" stopColor={light} />
                    <stop offset="1" stopColor={mid} />
                </linearGradient>
            </defs>
            {logo.draw({ base: `url(#${ids.base})`, face: `url(#${ids.face})`, mask: ids.mask })}
        </svg>
    );
}
