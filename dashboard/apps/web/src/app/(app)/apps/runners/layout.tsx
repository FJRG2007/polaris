import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Runners draws its words from this namespace. */
export default function RunnersLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["runners"]}>{children}</Messages>;
}
