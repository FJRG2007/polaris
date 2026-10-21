/** Network filter, Devices (/apps/dns-blocker/devices). The layout carries the settings. */

import { requireAdmin } from "@/lib/session";
import { DnsDevicesSection } from "../devices-section";

export const dynamic = "force-dynamic";

export default async function DnsBlockerDevicesPage() {
    await requireAdmin();
    return <DnsDevicesSection />;
}
