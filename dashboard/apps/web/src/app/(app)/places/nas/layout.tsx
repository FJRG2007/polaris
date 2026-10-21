import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The NAS screens share the UPS's namespace: both are machines' hardware. */
export default function NasLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["servers"]}>{children}</Messages>;
}
