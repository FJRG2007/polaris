/**
 * Drive (/drive): hands every client screen under it the `drive` words.
 * Nothing is awaited here but the catalog, so the first paint is not held up.
 */

import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

export default function DriveLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["drive"]}>{children}</Messages>;
}
