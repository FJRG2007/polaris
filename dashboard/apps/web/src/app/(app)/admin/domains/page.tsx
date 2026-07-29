/**
 * Domains admin panel (/admin/domains). Configure the app domain and the sharing
 * domain (used for share links and drop points), and manage DuckDNS. Admin-only.
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
        // Short page: centre it in the content area rather than leaving it stranded
        // at the top. Taller content simply grows and scrolls as usual.
        <div className="flex flex-1 flex-col justify-center">
            <PageHeader
                title="Domains"
                description="Choose the domains Polaris uses for the dashboard and for the links it hands out."
            />
            <DomainsView initialConfig={config} effectiveAppUrl={effectiveAppUrl} />
        </div>
    );
}
