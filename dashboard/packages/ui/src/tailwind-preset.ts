/**
 * Shared Tailwind preset. Apps extend this so every surface (dashboard, demo)
 * renders from the same token set defined in tokens.css. Colors reference the
 * CSS variables with the modern `<alpha-value>` slot so opacity utilities work.
 */

import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const withAlpha = (variable: string) => `hsl(var(--${variable}) / <alpha-value>)`;

const preset: Omit<Config, "content"> = {
    darkMode: ["class"],
    theme: {
        extend: {
            colors: {
                background: withAlpha("background"),
                surface: withAlpha("surface"),
                card: { DEFAULT: withAlpha("card"), hover: withAlpha("card-hover") },
                foreground: withAlpha("foreground"),
                muted: { DEFAULT: withAlpha("muted"), foreground: withAlpha("muted-foreground") },
                border: withAlpha("border"),
                input: withAlpha("input"),
                ring: withAlpha("ring"),
                primary: { DEFAULT: withAlpha("primary"), foreground: withAlpha("primary-foreground") },
                accent: { DEFAULT: withAlpha("accent"), foreground: withAlpha("accent-foreground") },
                success: withAlpha("success"),
                warning: withAlpha("warning"),
                danger: { DEFAULT: withAlpha("danger"), foreground: withAlpha("danger-foreground") }
            },
            borderRadius: {
                lg: "var(--radius)",
                md: "calc(var(--radius) - 4px)",
                sm: "calc(var(--radius) - 6px)"
            },
            fontFamily: {
                mono: ["var(--font-mono)", "ui-monospace", "monospace"]
            }
        }
    },
    plugins: [animate]
};

export default preset;
