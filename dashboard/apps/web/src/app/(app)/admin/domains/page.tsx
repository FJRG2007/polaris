/**
 * Domains admin panel (/admin/domains). The guided setup decides how the box is
 * exposed and under which domain; this page also holds Polaris's own addresses (the
 * app domain and the sharing domain used for share links and drop points), the root
 * certificate for `polaris.local`, and - under Advanced - the manual exposure and
 * DuckDNS controls. Admin-only.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { appBaseUrl, getDomainConfig } from "@/lib/domain-service";
import { DomainsView } from "./domains-view";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
    await requireAdmin();
    const [config, effectiveAppUrl] = await Promise.all([getDomainConfig(), appBaseUrl()]);

    return (
        <>
            <PageHeader
                title="Domains"
                description="Choose the domains Polaris uses for the dashboard and for the links it hands out."
            />
            <DomainsView initialConfig={config} effectiveAppUrl={effectiveAppUrl} />
        </>
    );
}
