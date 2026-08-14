// One stylesheet, which pulls in the design tokens itself: see globals.css for why
// the token import cannot live here.
import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { DropGuard } from "@/components/drop-guard";

/**
 * The typeface. Self-hosted rather than fetched from a font service: a build must
 * work with no network, and a request per visitor to a third party is a record of
 * who uses this instance held somewhere we do not control.
 *
 * IBM Plex Sans (and its mono companion for code, terminals and identifiers) is
 * drawn for interfaces that are read for hours - open counters, unambiguous
 * 1/l/I, a mono that lines up in a column. `swap` so text is readable before the
 * font lands, and the fallback is measured against the real face so the swap does
 * not reflow the page.
 */
const sans = localFont({
    src: [
        { path: "../fonts/IBMPlexSans-Regular.woff2", weight: "400", style: "normal" },
        { path: "../fonts/IBMPlexSans-Medium.woff2", weight: "500", style: "normal" },
        { path: "../fonts/IBMPlexSans-SemiBold.woff2", weight: "600", style: "normal" },
        { path: "../fonts/IBMPlexSans-Bold.woff2", weight: "700", style: "normal" }
    ],
    variable: "--font-plex-sans",
    display: "swap",
    adjustFontFallback: "Arial"
});

const mono = localFont({
    src: [
        { path: "../fonts/IBMPlexMono-Regular.woff2", weight: "400", style: "normal" },
        { path: "../fonts/IBMPlexMono-Medium.woff2", weight: "500", style: "normal" },
        { path: "../fonts/IBMPlexMono-SemiBold.woff2", weight: "600", style: "normal" }
    ],
    variable: "--font-plex-mono",
    display: "swap"
});

export const metadata: Metadata = {
    title: "Polaris",
    description: "Home-lab control plane - drive, connections, and more."
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
            <body>
                <DropGuard />
                {children}
            </body>
        </html>
    );
}
