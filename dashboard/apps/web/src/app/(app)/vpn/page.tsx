/**
 * VPN (/vpn): connect a device. Servers and who may use them are an
 * administrator's, under the app's settings.
 */

import { ConnectSection } from "./connect";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function VpnPage() {
    const user = await requireUser();
    return <ConnectSection isAdmin={user.isAdmin} />;
}
