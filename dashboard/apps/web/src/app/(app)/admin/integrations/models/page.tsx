/**
 * The model providers agents run on. Their own screen rather than a category in
 * the marketplace: there are more of them than of everything else put together,
 * and connecting one is a different job from connecting a service - no accounts
 * to link, no permissions to grant, just a key and whether runs may spend it.
 * Admin-only, because a key here is instance-wide.
 */

import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";
import { listIntegrationStates } from "@/lib/integration-service";
import { IntegrationsView, type IntegrationCard } from "../integrations-view";
import { MODEL_INTEGRATIONS, readGatewayConfig } from "@/lib/integrations/registry";

export const dynamic = "force-dynamic";

export default async function ModelProvidersPage() {
    await requireAdmin();
    const states = await listIntegrationStates();

    const cards: IntegrationCard[] = MODEL_INTEGRATIONS.map((entry) => {
        const state = states.get(entry.slug);
        return {
            slug: entry.slug,
            name: entry.name,
            category: entry.category,
            summary: entry.summary,
            description: entry.description,
            docsUrl: entry.docsUrl,
            setupLinks: entry.setupLinks,
            requiresApiKey: entry.requiresApiKey,
            apiKeyLabel: entry.apiKeyLabel,
            apiKeyHelp: entry.apiKeyHelp,
            enabled: state?.enabled ?? false,
            hasSecret: state?.hasSecret ?? false,
            gateway: entry.slug === GATEWAY_SLUG ? readGatewayConfig(state?.config) : undefined,
            // Owned by the marketplace cards, and meaningless here.
            scanDropPoints: true,
            onDetection: "block",
            verifyAccessIp: true,
            deny: []
        };
    });

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">AI providers</h1>
                <p className="text-sm text-muted-foreground">
                    Your own accounts with the model providers. A key is handed to a run over an authenticated call and
                    never written into a repository, so rotating it here takes effect everywhere at once. Every provider
                    bills you directly - Polaris adds nothing.
                </p>
            </div>
            <IntegrationsView cards={cards} />
            <p className="text-sm text-muted-foreground">
                Everything else Polaris connects to lives under{" "}
                <Link href="/integrations" className="text-primary hover:underline">
                    Integrations
                </Link>
                .
            </p>
        </div>
    );
}
