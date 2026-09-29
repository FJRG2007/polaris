import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The platform defaults are drawn with the Agents app's own card, which reads
 *  the `agents` catalog. */
export default function AdminAgentsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["agents"]}>{children}</Messages>;
}
