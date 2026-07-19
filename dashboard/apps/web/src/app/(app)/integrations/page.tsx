/**
 * Integrations marketplace. Lists the integrations Polaris can run and their
 * installed state. Admin-only: configuring one stores an instance-wide secret.
 */

import { requireAdmin } from "@/lib/session";
import { INTEGRATIONS, readVirusTotalConfig } from "@/lib/integrations/registry";
import { listIntegrationStates } from "@/lib/integration-service";
import { IntegrationsView, type IntegrationCard } from "./integrations-view";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
    await requireAdmin();
    const states = await listIntegrationStates();

    const cards: IntegrationCard[] = INTEGRATIONS.map((entry) => {
        const state = states.get(entry.slug);
        const virustotal = entry.slug === "virustotal" ? readVirusTotalConfig(state?.config) : undefined;
        return {
            slug: entry.slug,
            name: entry.name,
            category: entry.category,
            summary: entry.summary,
            description: entry.description,
            docsUrl: entry.docsUrl,
            requiresApiKey: entry.requiresApiKey,
            apiKeyLabel: entry.apiKeyLabel,
            apiKeyHelp: entry.apiKeyHelp,
            enabled: state?.enabled ?? false,
            hasSecret: state?.hasSecret ?? false,
            scanDropPoints: virustotal?.scanDropPoints ?? true,
            onDetection: virustotal?.onDetection ?? "block"
        };
    });

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
            <div>
                <h1 className="text-lg font-medium">Integrations</h1>
                <p className="text-sm text-muted-foreground">
                    Connect Polaris to outside services. Enabled integrations run across the platform.
                </p>
            </div>
            <IntegrationsView cards={cards} />
        </div>
    );
}
