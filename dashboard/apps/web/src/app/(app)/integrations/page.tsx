/**
 * Integrations marketplace. Lists the integrations Polaris can run and their
 * installed state. Admin-only: configuring one stores an instance-wide secret.
 */

import { requireAdmin } from "@/lib/session";
import { getGithubStatus } from "@/lib/github-service";
import { getRunnerAccess } from "@/lib/github-runners";
import { connectionLimit } from "@/lib/connections/store";
import { connectionCallbackUrl } from "@/lib/connections/oauth";
import { listIntegrationStates } from "@/lib/integration-service";
import { appBaseUrl, getDomainConfig } from "@/lib/domain-service";
import { IntegrationsView, type IntegrationCard } from "./integrations-view";
import { getCloudflareAccountStatus } from "@/lib/integrations/cloudflare-account-service";
import { INTEGRATIONS, readDymoConfig, readVirusTotalConfig } from "@/lib/integrations/registry";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
    await requireAdmin();
    // Three of these reach outside the box (GitHub twice, Cloudflare once), so
    // they are awaited together rather than one after another - in sequence the
    // page took as long as all of them added up.
    const [states, github, domains, cloudflare, baseUrl, githubLimit, googleLimit] = await Promise.all([
        listIntegrationStates(),
        getGithubStatus(),
        // DuckDNS config lives with the domain settings (Setting keys), not an Integration row.
        getDomainConfig(),
        // Cloudflare's API tokens (DNS records and named tunnels) are separate from the
        // marketplace connector token that runs the server-wide tunnel.
        getCloudflareAccountStatus(),
        // The address the deployment is reachable at, which is what decides the
        // redirect URI an operator has to register on their Google client.
        appBaseUrl(),
        // How many accounts of each service one person may connect, shown in the
        // dialog that sets it.
        connectionLimit("github"),
        connectionLimit("google")
    ]);
    // Whether that connection can also register self-hosted runners. Neither
    // method asks for the permission by default, so this is where the operator
    // finds out - before provisioning a machine, not after. It needs the status
    // above, so it is the one call that cannot join the batch.
    const runners = github.connected ? await getRunnerAccess() : null;

    const cards: IntegrationCard[] = INTEGRATIONS.map((entry) => {
        const state = states.get(entry.slug);
        const virustotal = entry.slug === "virustotal" ? readVirusTotalConfig(state?.config) : undefined;
        const dymo = entry.slug === "dymo" ? readDymoConfig(state?.config) : undefined;
        const isDuck = entry.slug === "duckdns";
        const duckConfigured = isDuck && domains.hasDuckdnsToken && Boolean(domains.duckdnsSubdomain);
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
            enabled: isDuck ? duckConfigured : state?.enabled ?? false,
            hasSecret: isDuck ? domains.hasDuckdnsToken : state?.hasSecret ?? false,
            duckdnsSubdomain: isDuck ? domains.duckdnsSubdomain : undefined,
            scanDropPoints: virustotal?.scanDropPoints ?? true,
            onDetection: virustotal?.onDetection ?? "block",
            verifyAccessIp: dymo?.verifyAccessIp ?? true,
            deny: dymo?.deny ?? ["FRAUD"],
            githubMethod: entry.slug === "github" ? github.method : undefined,
            githubLogin: entry.slug === "github" ? github.login ?? undefined : undefined,
            githubInstallations: entry.slug === "github" ? github.installations : undefined,
            githubHtmlUrl: entry.slug === "github" ? github.htmlUrl ?? undefined : undefined,
            githubRunnersReady: entry.slug === "github" ? runners?.ready : undefined,
            githubRunnersAdvice: entry.slug === "github" ? runners?.advice ?? undefined : undefined,
            cloudflareApiConnected: entry.slug === "cloudflare" ? cloudflare.connected : undefined,
            cloudflareDnsConnected: entry.slug === "cloudflare" ? cloudflare.dnsReady : undefined,
            cloudflareAccountName: entry.slug === "cloudflare" ? cloudflare.accountName ?? undefined : undefined,
            googleClientId:
                entry.slug === "google" && typeof state?.config.clientId === "string"
                    ? state.config.clientId
                    : undefined,
            googleCallbackUrl: entry.slug === "google" ? connectionCallbackUrl("google", baseUrl) : undefined,
            accountLimit:
                entry.slug === "github" ? githubLimit : entry.slug === "google" ? googleLimit : undefined
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
