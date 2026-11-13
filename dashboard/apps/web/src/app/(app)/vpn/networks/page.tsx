/**
 * Private networks (/vpn/networks): subnets that stay the same whichever
 * line or router a house uses, reached through the VPN. They ride on the device
 * mesh, so they are only here while it is switched on.
 */

import { notFound } from "next/navigation";
import { vpnMeshOn } from "@/lib/vpn/mesh";
import { requireUser } from "@/lib/session";
import { VpnNetworksSection } from "./networks";

export const dynamic = "force-dynamic";

export default async function VpnNetworksPage() {
    const user = await requireUser();
    if (!(await vpnMeshOn())) notFound();
    return <VpnNetworksSection isAdmin={user.isAdmin} />;
}
