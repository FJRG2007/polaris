/**
 * Domains admin panel (/admin/domains). Configure the app domain and the sharing
 * domain (used for share links and drop points), and manage DuckDNS. Admin-only.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { appBaseUrl, getDomainConfig } from "@/lib/domain-service";
import { getTunnelStatus } from "@/lib/tunnel-service";
import { DomainsView } from "./domains-view";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
    await requireAdmin();
    const [config, effectiveAppUrl, tunnel] = await Promise.all([
        getDomainConfig(),
        appBaseUrl(),
        getTunnelStatus()
    ]);

    return (
        <>
            <PageHeader
                title="Domains"
                description="Choose the domains Polaris uses for the dashboard and for the links it hands out."
            />
            <DomainsView initialConfig={config} effectiveAppUrl={effectiveAppUrl} initialTunnel={tunnel} />
        </>
    );
}
