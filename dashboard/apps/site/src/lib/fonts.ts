import localFont from "next/font/local";

/**
 * The dashboard's typeface, from the dashboard's own files, so the pages drawn
 * from its components read the same here. Folded into `--font-sans` in
 * `globals.css`, as the dashboard does.
 */
export const sans = localFont({
    src: [
        {
            path: "../../../web/src/fonts/IBMPlexSans-Regular.woff2",
            weight: "400",
            style: "normal"
        },
        { path: "../../../web/src/fonts/IBMPlexSans-Medium.woff2", weight: "500", style: "normal" },
        {
            path: "../../../web/src/fonts/IBMPlexSans-SemiBold.woff2",
            weight: "600",
            style: "normal"
        },
        { path: "../../../web/src/fonts/IBMPlexSans-Bold.woff2", weight: "700", style: "normal" }
    ],
    variable: "--font-plex-sans",
    display: "swap",
    adjustFontFallback: "Arial"
});
