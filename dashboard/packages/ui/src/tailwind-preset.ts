/**
 * Shared Tailwind preset. Apps extend this so every surface (dashboard, demo)
 * renders from the same token set defined in tokens.css. Colors reference the
 * CSS variables with the modern `<alpha-value>` slot so opacity utilities work.
 *
 * The scales here are deliberately short. A radius scale with four steps, two
 * shadows and one easing curve is a scale somebody can hold in their head, which
 * is what keeps a hundred screens looking like one product.
 */

import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const withAlpha = (variable: string) => `hsl(var(--${variable}) / <alpha-value>)`;

/**
 * A status's colour and the parts a chip is made of - see the Status block in
 * tokens.css. `soft` and `edge` are whole colours with their alpha already in
 * them, set per theme, so they take no opacity modifier: a chip that needs a
 * different tint needs a different token, not a different number at the site.
 */
const status = (name: string) => ({
    DEFAULT: withAlpha(name),
    ink: withAlpha(`${name}-ink`),
    soft: `var(--${name}-soft)`,
    edge: `var(--${name}-edge)`,
    solid: withAlpha(`${name}-solid`),
    foreground: withAlpha(`${name}-foreground`)
});

const preset: Omit<Config, "content"> = {
    darkMode: ["class"],
    theme: {
        extend: {
            colors: {
                // Depth, ground upwards.
                background: withAlpha("background"),
                surface: withAlpha("surface"),
                card: { DEFAULT: withAlpha("card"), hover: withAlpha("card-hover") },
                elevated: withAlpha("elevated"),
                // Text, brightest to faintest. `muted.foreground` is the second
                // step and `foreground.subtle` the third.
                foreground: {
                    DEFAULT: withAlpha("foreground"),
                    subtle: withAlpha("subtle-foreground")
                },
                muted: { DEFAULT: withAlpha("muted"), foreground: withAlpha("muted-foreground") },
                field: withAlpha("field"),
                border: { DEFAULT: withAlpha("border"), strong: withAlpha("border-strong") },
                ring: withAlpha("ring"),
                primary: {
                    DEFAULT: withAlpha("primary"),
                    foreground: withAlpha("primary-foreground")
                },
                accent: {
                    DEFAULT: withAlpha("accent"),
                    foreground: withAlpha("accent-foreground")
                },
                // `bg-success-soft text-success-ink border-success-edge` is a chip;
                // `bg-success-solid text-success-foreground` is a filled badge.
                // Amber and green are light colours here, so what is written on a
                // solid one is dark ink - never `text-background`, which turns
                // white on amber the moment the reader is not in the dark theme.
                success: status("success"),
                warning: status("warning"),
                danger: status("danger")
            },
            // 4/6/8/12px. Anything rounder starts to read as a toy rather than an
            // instrument, and the whole set moves together from --radius.
            borderRadius: {
                sm: "calc(var(--radius) - 4px)",
                md: "calc(var(--radius) - 2px)",
                lg: "var(--radius)",
                xl: "calc(var(--radius) + 4px)"
            },
            boxShadow: {
                popover: "var(--shadow-popover)",
                modal: "var(--shadow-modal)"
            },
            fontFamily: {
                sans: ["var(--font-sans)"],
                mono: ["var(--font-mono)", "ui-monospace", "monospace"]
            },
            transitionTimingFunction: {
                DEFAULT: "var(--ease)",
                ui: "var(--ease)"
            },
            transitionDuration: {
                DEFAULT: "var(--duration)",
                fast: "var(--duration-fast)"
            },
            // The top bar's height, for the panes pinned under it.
            spacing: {
                header: "var(--header-height)"
            },
            height: {
                "below-header": "calc(100vh - var(--header-height))"
            }
        }
    },
    plugins: [animate]
};

export default preset;
