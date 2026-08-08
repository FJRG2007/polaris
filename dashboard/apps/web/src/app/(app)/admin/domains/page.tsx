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
import { GamePortsCard } from "./game-ports-card";
import { getDomainZones } from "@/lib/domain-zones";
import { ownerDomainPolicy } from "@/lib/owner-domains";
import { checkedAddresses } from "@/lib/address-health";
import { OwnerDomainsCard } from "./owner-domains-card";
import { appBaseUrl, getDomainConfig } from "@/lib/domain-service";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
    await requireAdmin();
    // The zone layout is read here as well as by the setup, so the addresses below can
    // propose the configured domain on the first paint instead of after the setup has
    // finished loading and reported it.
    const [config, effectiveAppUrl, zones, addresses, ownerPolicy] = await Promise.all([
        getDomainConfig(),
        appBaseUrl(),
        getDomainZones(),
        checkedAddresses(),
        ownerDomainPolicy()
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
            {/* The zone check above is finished once 80 and 443 arrive, and a game
                server answers on neither - so what it needs is asked for here
                rather than folded into advice that disappears when the website
                works. Renders nothing when no game server exists. */}
            <div className="mt-4">
                <GamePortsCard />
            </div>

            {/* Below the instance's own addresses, because it is a different
                decision: not what Polaris answers on, but what other people are
                allowed to point at it. */}
            <div className="mt-4">
                <OwnerDomainsCard policy={ownerPolicy} />
            </div>
        </div>
    );
}
