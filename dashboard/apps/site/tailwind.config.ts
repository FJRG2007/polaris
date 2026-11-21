import preset from "@polaris/ui/preset";
import type { Config } from "tailwindcss";

/** The dashboard's tokens and the UI package's classes, so the site draws as the app does. */
const config: Config = {
    presets: [preset],
    // `hover:` only where the pointer really hovers, as in the dashboard: a phone
    // keeps the last tapped element "hovered" until the next tap.
    future: { hoverOnlyWhenSupported: true },
    content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"]
};

export default config;
