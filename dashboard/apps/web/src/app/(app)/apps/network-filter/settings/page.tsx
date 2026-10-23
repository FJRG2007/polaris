/** Network filter, Settings (/apps/network-filter/settings). The layout carries the settings. */

import { requireAdmin } from "@/lib/session";
import { DnsSettingsSection } from "../settings-section";

export const dynamic = "force-dynamic";

export default async function DnsBlockerSettingsPage() {
    await requireAdmin();
    return <DnsSettingsSection />;
}
