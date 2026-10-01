/**
 * The frame of Calendar's public pages: nothing but the dashboard's client
 * pieces an app's components draw with. No session is asked for - whoever holds
 * a page's link is who it is for, and the page itself decides what that reaches.
 */

import type { ReactNode } from "react";
import { ProvideAppHostUi } from "@/components/app-host/client";

export default function PublicCalendarLayout({ children }: { children: ReactNode }) {
    return (
        <>
            <ProvideAppHostUi />
            {children}
        </>
    );
}
