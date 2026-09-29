import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Deploy draws its words from these namespaces. */
export default function DeployLayout({ children }: { children: ReactNode }) {
    return (
        <Messages namespaces={["deploy", "deployConfig", "deployData", "deployProject", "deployService", "deploySettings"]}>
            {children}
        </Messages>
    );
}
