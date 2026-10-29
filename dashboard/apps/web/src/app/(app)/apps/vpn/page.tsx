/**
 * VPN (/apps/vpn): the Overview. Where the control server stands and the
 * address devices sign in to; an administrator turns it on and off here.
 */

import { requireUser } from "@/lib/session";
import { VpnOverviewSection } from "./overview";

export const dynamic = "force-dynamic";

export default async function VpnPage() {
    const user = await requireUser();
    return <VpnOverviewSection isAdmin={user.isAdmin} />;
}
