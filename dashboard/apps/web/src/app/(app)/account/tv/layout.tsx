/** The themes and add-ons picker draws the TV gallery, in its own words. */

import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

export default function TvLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["tvCompat"]}>{children}</Messages>;
}
