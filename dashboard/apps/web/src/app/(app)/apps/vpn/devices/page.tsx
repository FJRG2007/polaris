/**
 * VPN devices (/apps/vpn/devices): the reader's own devices, or every device
 * for an administrator, who also approves what a device offers.
 */

import { requireUser } from "@/lib/session";
import { VpnDevicesSection } from "./devices";

export const dynamic = "force-dynamic";

export default async function VpnDevicesPage() {
    const user = await requireUser();
    return <VpnDevicesSection isAdmin={user.isAdmin} />;
}
