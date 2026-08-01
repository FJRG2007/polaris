"use client";

/** The header button that opens the per-app rail on narrow viewports. An app
 *  with no sections (Watch) has no rail to open, so it renders no button. */

import { MobileNav } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { APP_SECTIONS, resolveActiveApp } from "@/lib/apps";

export function AppNavDrawer() {
    const pathname = usePathname();
    const app = resolveActiveApp(pathname);
    const hasSections = (APP_SECTIONS[app.id] ?? []).some((section) => !section.hidden);
    if (!hasSections) return null;
    return (
        <MobileNav>
            <AppSidebar />
        </MobileNav>
    );
}
