import type { Config } from "tailwindcss";
import preset from "@polaris/ui/preset";

/**
 * Tailwind scans the app, the UI package and every app package the dashboard
 * builds (see test/build/app-packages.test.ts), so classes used only there are
 * not purged. Design tokens come from the shared preset.
 */
const config: Config = {
    presets: [preset],
    content: [
        "./src/**/*.{ts,tsx}",
        "../../packages/ui/src/**/*.{ts,tsx}",
        "../places/src/**/*.{ts,tsx}",
        "../game-servers/src/**/*.{ts,tsx}"
    ]
};

export default config;
