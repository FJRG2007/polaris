import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Firewall draws its words from this namespace. */
export default function FirewallLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["firewall"]}>{children}</Messages>;
}
