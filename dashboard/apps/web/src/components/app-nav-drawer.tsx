"use client";

/** The header button that opens the per-app rail on narrow viewports. An app
 *  with no sections (Watch) has no rail to open, so it renders no button. */

import { MobileNav } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { APP_SECTIONS, OVERVIEW_APP_ID, resolveActiveApp, resolveSubapp } from "@/lib/apps";

export function AppNavDrawer({ appIds = [] }: { appIds?: string[] }) {
    const pathname = usePathname();
    const subapp = resolveSubapp(pathname);
    const app = resolveActiveApp(pathname);
    const sections = subapp ? subapp.sections : (APP_SECTIONS[app.id] ?? []);
    // The Overview's rail is the apps rather than a section list (see AppSidebar),
    // so it has one to open whenever this account can open anything else.
    const hasRail =
        !subapp && app.id === OVERVIEW_APP_ID
            ? appIds.some((id) => id !== OVERVIEW_APP_ID)
            : sections.some((section) => !section.hidden);
    if (!hasRail) return null;
    return (
        <MobileNav>
            <AppSidebar appIds={appIds} />
        </MobileNav>
    );
}
