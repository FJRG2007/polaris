/** The site's root address: the English overview, with the same frame. */

import type { ReactNode } from "react";
import type { Metadata } from "next";
import { words } from "@/lib/site";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = { title: "Polaris", description: words("en").meta.description };

export default function RootLayout({ children }: { children: ReactNode }) {
    return <SiteShell locale="en">{children}</SiteShell>;
}
