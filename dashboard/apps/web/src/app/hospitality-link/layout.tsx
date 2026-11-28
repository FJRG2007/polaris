/**
 * The frame of Hospitality's device page: only the client pieces an app's
 * components draw with. No session is asked for - a linked device carries its
 * own venue-scoped token, and the page decides what that reaches.
 */

import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";
import { ProvideAppHostUi } from "@/components/app-host/client";

export default function HospitalityDeviceLayout({ children }: { children: ReactNode }) {
    return (
        <Messages namespaces={["shortcuts"]}>
            <ProvideAppHostUi />
            {children}
        </Messages>
    );
}
