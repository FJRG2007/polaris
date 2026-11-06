/**
 * Add a device (/vpn/add): how to point each platform's Tailscale app at
 * this VPN, and a one-time key for a device that cannot open a browser.
 */

import * as vpn from "@/lib/vpn/service";
import { requireUser } from "@/lib/session";
import { AddDeviceSection } from "./add-device";
import { VpnNoAccess } from "../no-access";

export const dynamic = "force-dynamic";

export default async function VpnAddPage() {
    const user = await requireUser();
    if (!(await vpn.mayJoin(user))) return <VpnNoAccess />;
    return <AddDeviceSection />;
}
