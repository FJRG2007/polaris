/**
 * Downloads draws the TV checker in its install dialog, and the app it runs in
 * (version, updates), each in its own words.
 */

import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

export default function DownloadsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["tvCompat", "appSettings"]}>{children}</Messages>;
}
