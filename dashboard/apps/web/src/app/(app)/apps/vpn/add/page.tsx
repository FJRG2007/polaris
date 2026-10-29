/**
 * Add a device (/apps/vpn/add): how to point each platform's Tailscale app at
 * this VPN, and a one-time key for a device that cannot open a browser.
 */

import { requireUser } from "@/lib/session";
import { AddDeviceSection } from "./add-device";

export const dynamic = "force-dynamic";

export default async function VpnAddPage() {
    await requireUser();
    return <AddDeviceSection />;
}
