/** The site's root address: the English overview, with the same frame. */

import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata, SITE_VIEWPORT } from "@/lib/site";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = pageMetadata("en", {});
export const viewport = SITE_VIEWPORT;

export default function RootLayout({ children }: { children: ReactNode }) {
    return <SiteShell locale="en">{children}</SiteShell>;
}
