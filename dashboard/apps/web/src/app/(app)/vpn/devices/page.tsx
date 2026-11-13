/**
 * VPN devices (/vpn/devices): the devices that connect from Polaris's own apps -
 * the reader's own, or every one for an administrator. While the device mesh is
 * switched on, its devices follow under a heading of their own.
 */

import { requireUser } from "@/lib/session";
import { vpnMeshOn } from "@/lib/vpn/mesh";
import { VpnDevicesSection } from "./devices";
import { AppDevicesSection } from "./app-devices";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function VpnDevicesPage() {
    const [user, mesh, t] = await Promise.all([
        requireUser(),
        vpnMeshOn(),
        getTranslations("vpn")
    ]);
    return (
        <div className="flex flex-col gap-8">
            <AppDevicesSection isAdmin={user.isAdmin} />
            {mesh ? (
                <section className="flex min-w-0 flex-col gap-3">
                    <h2 className="text-sm font-medium">{t("mesh.devicesTitle")}</h2>
                    <VpnDevicesSection isAdmin={user.isAdmin} />
                </section>
            ) : null}
        </div>
    );
}
