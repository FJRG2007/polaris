import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Databases draws its words from this namespace. */
export default function DatabasesLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["databases"]}>{children}</Messages>;
}
