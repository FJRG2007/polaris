/**
 * Domains admin panel (/admin/domains). The guided setup decides how the box is
 * exposed and under which domain; this page also holds Polaris's own addresses (the
 * app domain and the sharing domain used for share links and drop points), the root
 * certificate for `polaris.local`, and - under Advanced - the manual exposure and
 * DuckDNS controls. Admin-only.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { DomainsView } from "./domains-view";
import { getDomainZones } from "@/lib/domain-zones";
import { checkedAddresses } from "@/lib/address-health";
import { appBaseUrl, getDomainConfig } from "@/lib/domain-service";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
    await requireAdmin();
    // The zone layout is read here as well as by the setup, so the addresses below can
    // propose the configured domain on the first paint instead of after the setup has
    // finished loading and reported it.
    const [config, effectiveAppUrl, zones, addresses] = await Promise.all([
        getDomainConfig(),
        appBaseUrl(),
        getDomainZones(),
        checkedAddresses()
    ]);

    return (
        // Narrow page: centre the column in the content area, header included.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Domains"
                description="Choose the domains Polaris uses for the dashboard and for the links it hands out."
            />
            <DomainsView
                initialConfig={config}
                initialZones={zones}
                initialAddresses={addresses}
                effectiveAppUrl={effectiveAppUrl}
            />
        </div>
    );
}
