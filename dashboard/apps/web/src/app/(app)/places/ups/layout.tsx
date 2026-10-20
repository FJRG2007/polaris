import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The UPS screens kept their words when they moved out of Servers. */
export default function UpsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["servers"]}>{children}</Messages>;
}
