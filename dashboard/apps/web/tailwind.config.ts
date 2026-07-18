import type { Config } from "tailwindcss";
import preset from "@polaris/ui/preset";

/**
 * Tailwind scans both the app and the UI package so component classes defined in
 * @polaris/ui are not purged. Design tokens come from the shared preset.
 */
const config: Config = {
    presets: [preset],
    content: [
        "./src/**/*.{ts,tsx}",
        "../../packages/ui/src/**/*.{ts,tsx}"
    ]
};

export default config;
