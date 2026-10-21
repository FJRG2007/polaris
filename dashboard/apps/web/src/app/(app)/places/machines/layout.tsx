import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The machine screens speak in the hardware namespace, and draw the cards and
 *  charts that Watch's words still label. */
export default function MachinesLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["servers", "watch"]}>{children}</Messages>;
}
