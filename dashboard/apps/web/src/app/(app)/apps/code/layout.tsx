import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Code draws its words from this namespace. */
export default function CodeLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["code"]}>{children}</Messages>;
}
