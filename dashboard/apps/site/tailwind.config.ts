import preset from "@polaris/ui/preset";
import type { Config } from "tailwindcss";

/** The dashboard's tokens and the UI package's classes, so the site draws as the app does. */
const config: Config = {
    presets: [preset],
    content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"]
};

export default config;
