/**
 * Settings > This app's words (and the Vault's, for the hosts' QR scanner),
 * above the page and its loading state alike, so the screen the loading state
 * draws is the same one the page does.
 */

import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

export default function AppSettingsLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["appSettings", "vault"]}>{children}</Messages>;
}
