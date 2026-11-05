import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** An announcement's page and its not-found answer both draw from this namespace. */
export default function AnnouncementsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["announcements"]}>{children}</Messages>;
}
