/**
 * One page of Polar's settings, by section: each route under
 * /polar/settings/<section> renders this with its own id.
 *
 * Every client section renders at once; only the two lists the server reads
 * stream in behind skeletons shaped like them.
 */

import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { homePathForUser, requireUser } from "@/lib/session";
import { mcpTools } from "@/lib/mcp/catalog";
import { PolarUsageSettings } from "./polar-usage";
import { polarAccessFor } from "@/lib/polar/access";
import { PolarConnectors } from "./polar-connectors";
import { getTranslations } from "@/lib/i18n/request";
import { listGrants } from "@/lib/polar/tool-grants";
import { PolarToolGrants } from "./polar-tool-grants";
import { Messages } from "@/components/i18n/messages";
import { PolarRoutingSettings } from "./polar-routing";
import { Card, CardBody, Skeleton } from "@polaris/ui";
import { PolarBrowserSites } from "./polar-browser-sites";
import { PolarSkills } from "./polar-skills";
import { listSkills } from "@/lib/polar/skills/store";
import { PolarAgents } from "./polar-agents";
import { listAgents } from "@/lib/polar/agents/store";
import type { AgentWork } from "@/lib/polar/agents/shared";
import { agentOptionsFor } from "@/lib/agents/agent-readiness";
import { agentDefaultsFor } from "@/lib/polar/agents/defaults";
import { agentEnginesFor } from "@/lib/polar/agents/composer-agents";
import { polarModelOptions } from "@/lib/polar/models";
import { connectorPolicy, listConnectorViews } from "@/lib/polar/connectors/store";
import { DisplaySettings } from "@/components/polar/polar-display";
import { PolarHelperSettings } from "@/components/polar/polar-helper-settings";
import { DataSettings, MemorySettings, PolarToolSettings } from "@/components/polar/polar-settings";
import {
    FIRST_SETTINGS_SECTION,
    settingsSection,
    type PolarSettingsSection
} from "@/lib/polar/settings-path";

/** The tab title: the page, then Polar's settings. */
export async function sectionMetadata(id: PolarSettingsSection): Promise<Metadata> {
    const t = await getTranslations("polar");
    const names: Record<PolarSettingsSection, string> = {
        memory: t("settings.memory.title"),
        tools: t("settings.tools.title"),
        connectors: t("settings.nav.connectors"),
        skills: t("settings.nav.skills"),
        agents: t("settings.nav.agents"),
        permissions: t("settings.nav.permissions"),
        browser: t("settings.browserSites.title"),
        display: t("settings.display.title"),
        extras: t("settings.helper.title"),
        routing: t("settings.nav.routing"),
        "coding-tools": t("settings.nav.codingTools"),
        usage: t("settings.nav.usage"),
        data: t("settings.data.title")
    };
    return { title: `${names[id]} - ${t("settings.title")}` };
}

/** The list, once the grants and the tool titles are read. */
async function GrantsSection({ userId }: { userId: string }) {
    const [grants, tools] = await Promise.all([listGrants(userId), mcpTools()]);
    const titles = new Map(tools.map((entry) => [entry.name, entry.title ?? entry.name]));
    return (
        <PolarToolGrants
            grants={grants.map((grant) => ({
                id: grant.id,
                tool: grant.tool,
                title: titles.get(grant.tool) ?? null,
                targetName: grant.target ? grant.targetName || grant.target : null,
                createdAt: grant.createdAt.toISOString()
            }))}
        />
    );
}

/** The connectors, once read; secrets never leave the server. */
async function ConnectorsSection({
    userId,
    returned
}: {
    userId: string;
    returned: "signed_in" | "failed" | null;
}) {
    const [initial, policy] = await Promise.all([listConnectorViews(userId), connectorPolicy()]);
    return <PolarConnectors initial={initial} returned={returned} hosts={policy.hosts} />;
}

/** The skills, once read; a viewer acting as somebody else reads and never writes. */
async function SkillsSection({ userId, readOnly }: { userId: string; readOnly: boolean }) {
    return <PolarSkills initial={await listSkills(userId)} readOnly={readOnly} />;
}

/** The agents, with the skills, connectors and models they can be given. */
async function AgentsSection({ userId, readOnly }: { userId: string; readOnly: boolean }) {
    const access = await polarAccessFor(userId);
    const [agents, skills, connectors, providers, engines, defaults] = await Promise.all([
        listAgents(userId),
        listSkills(userId),
        access.connectors ? listConnectorViews(userId) : Promise.resolve([]),
        polarModelOptions(userId, access).catch(() => []),
        agentOptionsFor(userId)
            .then(agentEnginesFor)
            .catch(() => []),
        agentDefaultsFor(userId).catch(() => new Map<string, AgentWork>())
    ]);
    const models = providers
        .flatMap((provider) =>
            provider.models.map((option) => ({
                provider: option.provider,
                model: option.model,
                label: `${option.providerName}: ${option.name}`
            }))
        )
        .slice(0, 1000);
    return (
        <PolarAgents
            initial={agents}
            defaults={[...defaults.values()]}
            readOnly={readOnly}
            picks={{
                skills: skills.map((skill) => skill.name),
                connectors: connectors.map((entry) => ({ id: entry.id, name: entry.name })),
                models,
                engines
            }}
        />
    );
}

export function ListSkeleton() {
    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
            </CardBody>
        </Card>
    );
}

export async function SettingsSectionPage({
    id,
    connector = null
}: {
    id: PolarSettingsSection;
    /** How a connector sign-in came back, on the connectors page. */
    connector?: string | null;
}) {
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    // The layout sends somebody without Polar away; this is the same gate for
    // a page reached on its own.
    if (!access.use) redirect(await homePathForUser(user));
    const connectorsListed = access.connectors && !user.viewingAs;
    if (id === "connectors" && !connectorsListed) redirect(settingsSection(FIRST_SETTINGS_SECTION));
    const returned = connector === "signed_in" || connector === "failed" ? connector : null;
    switch (id) {
        case "memory":
            return <MemorySettings />;
        case "tools":
            return <PolarToolSettings connectorsListed={connectorsListed} />;
        case "permissions": {
            const account = await getTranslations("account");
            return (
                <section className="flex flex-col gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium text-foreground">
                            {account("polarTools.title")}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {account("polarTools.intro")}
                        </p>
                        <p className="text-xs text-foreground-subtle">
                            {account("polarTools.stillChecked")}
                        </p>
                    </div>
                    {/* The two lists moved here from the account pages and still
                        read their words from there. */}
                    <Messages namespaces={["account"]}>
                        <Suspense fallback={<ListSkeleton />}>
                            <GrantsSection userId={user.id} />
                        </Suspense>
                    </Messages>
                </section>
            );
        }
        case "browser": {
            const t = await getTranslations("polar");
            return (
                <section className="flex flex-col gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium text-foreground">
                            {t("settings.browserSites.title")}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {t("settings.browserSites.intro")}
                        </p>
                    </div>
                    <PolarBrowserSites />
                </section>
            );
        }
        case "connectors":
            return (
                <Messages namespaces={["account"]}>
                    <Suspense fallback={<ListSkeleton />}>
                        <ConnectorsSection userId={user.id} returned={returned} />
                    </Suspense>
                </Messages>
            );
        case "skills":
            return (
                <Suspense fallback={<ListSkeleton />}>
                    <SkillsSection userId={user.id} readOnly={Boolean(user.viewingAs)} />
                </Suspense>
            );
        case "agents":
            return (
                <Suspense fallback={<ListSkeleton />}>
                    <AgentsSection userId={user.id} readOnly={Boolean(user.viewingAs)} />
                </Suspense>
            );
        case "display":
            return <DisplaySettings />;
        case "extras":
            return <PolarHelperSettings />;
        case "routing":
            return <PolarRoutingSettings part="fallbacks" />;
        case "coding-tools":
            return <PolarRoutingSettings part="tools" />;
        case "usage":
            return <PolarUsageSettings />;
        case "data":
            return <DataSettings />;
    }
}
