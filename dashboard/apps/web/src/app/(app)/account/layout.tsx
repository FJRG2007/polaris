/**
 * The account screens' words, handed to every client component under
 * /account at once - the way the admin layout does for Management - so a page
 * or a card moved between screens keeps translating without a `<Messages>` of
 * its own. The organization pages add their own namespace on top.
 */

import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

export default function AccountLayout({ children }: { children: ReactNode }) {
    return (
        <Messages namespaces={["account", "accountSecurity", "accountPrivacy", "accountNotifications", "validation"]}>
            {children}
        </Messages>
    );
}
