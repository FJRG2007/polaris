import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The admin marketplace draws on the store's words, as /apps/marketplace does. */
export default function PolarisAppsLayout({ children }: { children: ReactNode }) {
    return (
        <Messages
            // The new-service form's login option (deployService, firewall) rides on
            // the template form the store opens.
            namespaces={[
                "marketplace",
                "validation",
                "catalog",
                "deploy",
                "deployService",
                "firewall"
            ]}
        >
            {children}
        </Messages>
    );
}
