import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Servers draws its words from this namespace. */
export default function ServersLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["servers", "containers"]}>{children}</Messages>;
}
