import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Watch draws its words from this namespace. */
export default function WatchLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["watch"]}>{children}</Messages>;
}
