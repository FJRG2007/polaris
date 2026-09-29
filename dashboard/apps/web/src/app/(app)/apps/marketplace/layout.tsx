import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The Marketplace draws its words from this namespace. */
export default function MarketplaceLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["marketplace"]}>{children}</Messages>;
}
