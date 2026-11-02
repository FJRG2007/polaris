/**
 * Private networks (/vpn/networks): subnets that stay the same whichever
 * line or router a house uses, reached through the VPN.
 */

import { requireUser } from "@/lib/session";
import { VpnNetworksSection } from "./networks";

export const dynamic = "force-dynamic";

export default async function VpnNetworksPage() {
    const user = await requireUser();
    return <VpnNetworksSection isAdmin={user.isAdmin} />;
}
