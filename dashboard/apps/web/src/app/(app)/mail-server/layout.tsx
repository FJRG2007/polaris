import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of the mail server draws its words from this namespace. */
export default function MailServerLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["mailServer"]}>{children}</Messages>;
}
