/**
 * Join the device mesh (/vpn/add): how to point each platform's client at this
 * VPN, and a one-time key for a device that cannot open a browser. Only there
 * while the mesh is switched on.
 */

import * as vpn from "@/lib/vpn/service";
import { notFound } from "next/navigation";
import { vpnMeshOn } from "@/lib/vpn/mesh";
import { requireUser } from "@/lib/session";
import { AddDeviceSection } from "./add-device";
import { VpnNoAccess } from "../no-access";

export const dynamic = "force-dynamic";

export default async function VpnAddPage() {
    const user = await requireUser();
    if (!(await vpnMeshOn())) notFound();
    if (!(await vpn.mayJoin(user))) return <VpnNoAccess />;
    return <AddDeviceSection />;
}
