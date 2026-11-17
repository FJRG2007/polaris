import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The Marketplace draws its words from this namespace. */
export default function MarketplaceLayout({ children }: { children: ReactNode }) {
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
