/**
 * A Hospitality device (handheld, till, kitchen screen): outside the app shell
 * and outside sign-in. Unlinked it shows a code, linked it acts for its venue
 * only (see the hospitality app, `routes/hospitality-link`).
 */

import "@/lib/app-host/server";
import type { Metadata, Viewport } from "next";
import { renderAppPage, type AppPageProps } from "@/lib/app-bundles/serve-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    robots: { index: false, follow: false },
    manifest: "/hospitality-link/manifest.webmanifest",
    // Added to the home screen, it opens full screen, like an app.
    appleWebApp: { capable: true, statusBarStyle: "black-translucent" }
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function HospitalityDevicePage(props: AppPageProps) {
    return renderAppPage("/hospitality-link", "hospitality", props, { public: true });
}
