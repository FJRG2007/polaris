import type { Config } from "tailwindcss";
import preset from "@polaris/ui/preset";

/**
 * Tailwind scans the app, the UI package and every app package the dashboard
 * builds (see test/build/app-packages.test.ts), so classes used only there are
 * not purged. Design tokens come from the shared preset.
 */
const config: Config = {
    presets: [preset],
    // `hover:` only where the pointer really hovers. A touch screen keeps the
    // last tapped element "hovered" until the next tap, so every round icon
    // button on a phone stayed lit after it was pressed.
    future: { hoverOnlyWhenSupported: true },
    content: [
        "./src/**/*.{ts,tsx}",
        "../../packages/ui/src/**/*.{ts,tsx}",
        "../places/src/**/*.{ts,tsx}",
        "../game-servers/src/**/*.{ts,tsx}",
        "../calendar/src/**/*.{ts,tsx}",
        "../crm/src/**/*.{ts,tsx}",
        "../status-pages/src/**/*.{ts,tsx}",
        "../translate/src/**/*.{ts,tsx}",
        "../security-scans/src/**/*.{ts,tsx}",
        "../cloud-servers/src/**/*.{ts,tsx}"
    ]
};

export default config;
