import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** A plugin's page draws its screenshots with the Marketplace's gallery, in the store's words. */
export default function PluginsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["marketplace"]}>{children}</Messages>;
}
