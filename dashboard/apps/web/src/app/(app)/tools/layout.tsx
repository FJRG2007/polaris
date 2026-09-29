import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Tools draws its words from this namespace. */
export default function ToolsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["tools"]}>{children}</Messages>;
}
