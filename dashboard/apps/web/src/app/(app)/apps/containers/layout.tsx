import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Containers draws its words from this namespace. */
export default function ContainersLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["containers"]}>{children}</Messages>;
}
