import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Tunnels draws its words from this namespace. */
export default function TunnelsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["tunnels"]}>{children}</Messages>;
}
