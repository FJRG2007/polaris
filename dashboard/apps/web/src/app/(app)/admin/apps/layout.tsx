import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The admin marketplace draws on the store's words, as /apps/marketplace does. */
export default function PolarisAppsLayout({ children }: { children: ReactNode }) {
    return (
        <Messages namespaces={["marketplace", "validation", "catalog", "deploy"]}>
            {children}
        </Messages>
    );
}
