import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Analytics draws its words from this namespace. */
export default function AnalyticsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["analytics"]}>{children}</Messages>;
}
