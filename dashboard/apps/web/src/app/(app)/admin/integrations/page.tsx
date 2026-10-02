/**
 * Integrations marketplace. Lists the integrations Polaris can run and their
 * installed state. Admin-only: configuring one stores an instance-wide secret.
 */

import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { getGithubStatus } from "@/lib/github-service";
import { getRunnerAccess } from "@/lib/github-runners";
import { connectionProven } from "@/lib/connections/proven";
import { listIntegrationStates } from "@/lib/integration-service";
import { readConnectionFailure } from "@/lib/connections/attention";
import { readCriminalIpConfig } from "@/lib/integrations/criminalip";
import { getDomainConfig, publicAppUrl } from "@/lib/domain-service";
import { CONNECTION_PROVIDERS, findConnectionProvider } from "@polaris/core";
import { IntegrationsView, type IntegrationCard } from "./integrations-view";
import { commonSetupValues, setupValuesFor } from "@/lib/integrations/setup-values";
import { getCloudflareAccountStatus } from "@/lib/integrations/cloudflare-account-service";
import {
    OAUTH_APP_SLUGS,
    connectionCallbackUrl,
    connectionFlowOrigin
} from "@/lib/connections/oauth";
import {
    SERVICE_INTEGRATIONS,
    readDymoConfig,
    readVirusTotalConfig
} from "@/lib/integrations/registry";
import {
    connectionEmailTrusted,
    connectionLimit,
    connectionSignInAllowed
} from "@/lib/connections/store";
import { integrationWords } from "@/lib/integrations/registry-words";

export const dynamic = "force-dynamic";

/** Whether each service people can link an account of may also sign them in,
 *  keyed by slug. Read together so the cards can be built without awaiting. */
async function signInAllowances(): Promise<Map<string, boolean>> {
    const entries = await Promise.all(
        CONNECTION_PROVIDERS.map(
            async (provider) =>
                [provider.slug, await connectionSignInAllowed(provider.slug)] as const
        )
    );
    return new Map(entries);
}

/** Whether each service's word confirms the address it hands over, keyed by slug.
 *  Only the services that hand one over are in it; the rest have no switch. */
async function emailTrustAllowances(): Promise<Map<string, boolean>> {
    const entries = await Promise.all(
        CONNECTION_PROVIDERS.filter((provider) => provider.emailTrustDefault !== undefined).map(
            async (provider) =>
                [provider.slug, await connectionEmailTrusted(provider.slug)] as const
        )
    );
    return new Map(entries);
}

/** Whether each service has ever taken somebody all the way through here. Until it
 *  has, it is offered to nobody but an administrator, and the dialog says so. */
async function provenApplications(): Promise<Map<string, boolean>> {
    const entries = await Promise.all(
        CONNECTION_PROVIDERS.map(
            async (provider) => [provider.slug, await connectionProven(provider.slug)] as const
        )
    );
    return new Map(entries);
}

export default async function IntegrationsPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requireAdmin();
    // `?configure=<slug>` opens that service's setup straight away: what another
    // screen links to when it has just said the service is not set up yet.
    const asked = (await searchParams).configure;
    const configure =
        typeof asked === "string" && /^[a-z0-9-]{1,40}$/.test(asked) ? asked : null;
    const t = await getTranslations("admin");
    // Three of these reach outside the box (GitHub twice, Cloudflare once), so
    // they are awaited together rather than one after another - in sequence the
    // page took as long as all of them added up.
    const [
        states,
        github,
        domains,
        cloudflare,
        baseUrl,
        publicUrl,
        githubLimit,
        oauthLimits,
        signIn,
        proven,
        emailTrust
    ] = await Promise.all([
        listIntegrationStates(),
        getGithubStatus(),
        // DuckDNS config lives with the domain settings (Setting keys), not an Integration row.
        getDomainConfig(),
        // Cloudflare's API tokens (DNS records and named tunnels) are separate from the
        // marketplace connector token that runs the server-wide tunnel.
        getCloudflareAccountStatus(),
        // The address every connection round trip runs on, which is what decides
        // the redirect URI an operator has to register on their OAuth client. The
        // same function the flow itself calls, so what is copied from here is the
        // string that will be sent.
        connectionFlowOrigin(),
        // The same address, but only when GitHub's own servers could reach it: a
        // new App is created without a webhook when they cannot, and the dialog
        // says so before somebody creates one and waits for events.
        publicAppUrl(),
        // How many accounts of each service one person may connect, shown in the
        // dialog that sets it.
        connectionLimit("github"),
        Promise.all(
            OAUTH_APP_SLUGS.map(async (slug) => [slug, await connectionLimit(slug)] as const)
        ),
        // Whether each of those services may sign anybody in here. Resolved for
        // every provider at once so the card mapping below stays synchronous.
        signInAllowances(),
        provenApplications(),
        // And whether each one's word confirms the address it hands over. Same
        // reason: resolved up front so the mapping below stays synchronous.
        emailTrustAllowances()
    ]);
    const accountLimits = new Map(oauthLimits);
    // What a step can ask the operator to paste in: the public pages a review desk
    // reads, the domain under them, and the logo Epic wants uploaded. Built from
    // the address the round trips run on, so what is copied is what is sent.
    const common = commonSetupValues(baseUrl);

    // Whether that connection can also register self-hosted runners. Neither
    // method asks for the permission by default, so this is where the operator
    // finds out - before provisioning a machine, not after. It asks GitHub and
    // needs the status above, so it is not awaited here: the promise goes to the
    // view and only the note in the GitHub dialog waits for it. A failed check
    // leaves the note out rather than taking the whole page down.
    const runners = github.connected
        ? getRunnerAccess().then(
              (access) => ({ ready: access.ready, advice: access.advice }),
              (error: unknown) => {
                  console.error("[integrations] runner access check failed", error);
                  return null;
              }
          )
        : undefined;

    const cards: IntegrationCard[] = SERVICE_INTEGRATIONS.map((entry) => {
        const state = states.get(entry.slug);
        // The service's own copy, in the reader's words.
        const words = integrationWords(t, entry);
        // Set only for the services somebody can link an account of; the rest
        // have nothing to sign in with, so the switch is left out entirely.
        const connection = findConnectionProvider(entry.slug);
        const virustotal =
            entry.slug === "virustotal" ? readVirusTotalConfig(state?.config) : undefined;
        const dymo = entry.slug === "dymo" ? readDymoConfig(state?.config) : undefined;
        // Criminal IP carries the same shape - which verdicts block - read through
        // its own module because the rule names are theirs, not Dymo's.
        const criminalIp =
            entry.slug === "criminalip" ? readCriminalIpConfig(state?.config) : undefined;
        const isDuck = entry.slug === "duckdns";
        const duckConfigured =
            isDuck && domains.hasDuckdnsToken && Boolean(domains.duckdnsSubdomain);
        return {
            slug: entry.slug,
            name: entry.name,
            category: entry.category,
            summary: words.summary,
            description: words.description,
            docsUrl: entry.docsUrl,
            setupLinks: words.setupLinks,
            // Per provider, because each one returns to its own path.
            setupValues: setupValuesFor(entry.slug, common, {
                oauthApp: OAUTH_APP_SLUGS.includes(entry.slug),
                baseUrl
            }),
            // Only where an authorization can fail: a card with no round trip has
            // nothing to have been refused.
            failure: connection ? (readConnectionFailure(state?.config) ?? undefined) : undefined,
            signInAllowed: connection
                ? (signIn.get(entry.slug) ?? connection.signInDefault)
                : undefined,
            signInWarning: connection?.signInWarning,
            // Undefined for a service that vouches for no address, which is what
            // leaves the switch out rather than drawing one that decides nothing.
            emailTrusted: emailTrust.get(entry.slug),
            requiresApiKey: entry.requiresApiKey,
            apiKeyLabel: words.apiKeyLabel,
            apiKeyHelp: words.apiKeyHelp,
            enabled: isDuck ? duckConfigured : (state?.enabled ?? false),
            hasSecret: isDuck ? domains.hasDuckdnsToken : (state?.hasSecret ?? false),
            duckdnsSubdomain: isDuck ? domains.duckdnsSubdomain : undefined,
            scanDropPoints: virustotal?.scanDropPoints ?? true,
            onDetection: virustotal?.onDetection ?? "block",
            verifyAccessIp: dymo?.verifyAccessIp ?? true,
            deny: dymo?.deny ?? criminalIp?.deny ?? ["FRAUD"],
            githubMethod: entry.slug === "github" ? github.method : undefined,
            githubLogin: entry.slug === "github" ? (github.login ?? undefined) : undefined,
            githubInstallations: entry.slug === "github" ? github.installations : undefined,
            githubHtmlUrl: entry.slug === "github" ? (github.htmlUrl ?? undefined) : undefined,
            githubPublicUrl: entry.slug === "github" ? (publicUrl ?? undefined) : undefined,
            cloudflareApiConnected: entry.slug === "cloudflare" ? cloudflare.connected : undefined,
            cloudflareDnsConnected: entry.slug === "cloudflare" ? cloudflare.dnsReady : undefined,
            cloudflareAccountName:
                entry.slug === "cloudflare" ? (cloudflare.accountName ?? undefined) : undefined,
            oauthClientId:
                OAUTH_APP_SLUGS.includes(entry.slug) && typeof state?.config.clientId === "string"
                    ? state.config.clientId
                    : undefined,
            oauthCallbackUrl: OAUTH_APP_SLUGS.includes(entry.slug)
                ? connectionCallbackUrl(entry.slug, baseUrl)
                : undefined,
            // Whether anybody has been taken through this application yet. Set for
            // the services somebody links an account of, and only where there is
            // an application to prove - Steam has none.
            proven:
                connection && entry.slug !== "steam"
                    ? (proven.get(entry.slug) ?? false)
                    : undefined,
            // Where the licensed call filter is served from. Not a secret - the
            // token beside it is - so it is read back into the dialog.
            filterModuleUrl:
                entry.slug === "krisp" && typeof state?.config.moduleUrl === "string"
                    ? state.config.moduleUrl
                    : undefined,
            accountLimit:
                entry.slug === "github"
                    ? githubLimit
                    : OAUTH_APP_SLUGS.includes(entry.slug)
                      ? (accountLimits.get(entry.slug) ?? 1)
                      : undefined
        };
    });

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("integrations.page.title")}
                </h1>
                <p className="text-muted-foreground text-sm">
                    {t.rich("integrations.page.intro", {
                        link: (chunks) => (
                            <Link
                                key="link"
                                href="/admin/integrations/models"
                                className="text-primary hover:underline"
                            >
                                {chunks}
                            </Link>
                        )
                    })}
                </p>
            </div>
            <IntegrationsView cards={cards} runnerAccess={runners} configure={configure} />
        </div>
    );
}
