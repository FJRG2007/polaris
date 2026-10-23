// Every screen poll sent through its own route, end to end: the browser half
// builds the query, the route's schema reads it back, and the action it
// replaces is called with what the screen asked for. The screen tests replace
// the poll modules (test/setup/app-polls.ts), so this is where a parameter the
// two halves disagree on is caught.
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ backgroundUser: vi.fn(), requireUser: vi.fn() }));
const admin = vi.hoisted(() => ({ apiAdmin: vi.fn() }));
const actions = vi.hoisted(() => {
    const names = [
        "databaseOverviewAction",
        "listDatabaseProcessesAction",
        "cutoverPanelAction",
        "refreshExternalServiceAction",
        "projectGlanceAction",
        "deployFreshnessAction",
        "imageUpdateAction",
        "listDeploymentsAction",
        "listPromotionsAction",
        "serverEdgeAction",
        "enrollmentStatusAction",
        "sessionScreenAction",
        "dnsInsightsAction",
        "dnsTailAction",
        "tunnelStatusesAction",
        "readAppWidgetsAction",
        "listConversationsAction",
        "getMessagesAction",
        "listActivityAction",
        "channelStateAction",
        "serverDetailAction",
        "getRunAction",
        "checkUpdatesAction",
        "readOwnerDomainAction",
        "dnsPropagationAction",
        "readCallAction",
        "recoveryStatusAction",
        "buildMachineAction",
        "listServiceCronRunsAction",
        "deployBehaviourAction",
        "databaseConnectionAction",
        "listDatabaseInstancesAction",
        "listProviderChoicesAction",
        "listProviderAccountsAction",
        "moveOutPlanAction",
        "moveHomePlanAction",
        "serviceGpuAction",
        "deploymentDiagnosisAction",
        "servicePortsAction",
        "domainReadingsAction",
        "tcpProxiesAction",
        "serviceScalingAction",
        "serviceFollowStateAction",
        "serviceHistoryAction",
        "listDeployServersAction",
        "quickTunnelStatusAction",
        "ngrokTunnelStatusAction",
        "namedTunnelStatusAction",
        "domainHealthAction",
        "cloudflareAccountStatusAction",
        "serviceSourceAction",
        "uploadedSourceAction",
        "listAutomationRunsAction",
        "previewPromotionAction",
        "volumeDetailAction",
        "variableGroupReachAction",
        "serviceTagsAction",
        "revealEnvScopeAction",
        "listNasConnectionsAction"
    ] as const;
    return Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<
        (typeof names)[number],
        ReturnType<typeof vi.fn>
    >;
});

vi.mock("@/lib/session", () => session);
vi.mock("@/lib/api-session", () => admin);
vi.mock("@/lib/orgs/org-service", () => ({ requireOrgPermission: vi.fn() }));
vi.mock("@/app/(app)/apps/deploy/database-actions", () => ({
    databaseOverviewAction: actions.databaseOverviewAction,
    listDatabaseProcessesAction: actions.listDatabaseProcessesAction
}));
vi.mock("@/app/(app)/apps/deploy/dns-cutover-actions", () => ({
    cutoverPanelAction: actions.cutoverPanelAction
}));
vi.mock("@/app/(app)/apps/deploy/external-actions", () => ({
    refreshExternalServiceAction: actions.refreshExternalServiceAction,
    listProviderChoicesAction: actions.listProviderChoicesAction,
    listProviderAccountsAction: actions.listProviderAccountsAction,
    moveOutPlanAction: actions.moveOutPlanAction,
    moveHomePlanAction: actions.moveHomePlanAction
}));
vi.mock("@/app/(app)/apps/deploy/glance-actions", () => ({
    projectGlanceAction: actions.projectGlanceAction,
    deployFreshnessAction: actions.deployFreshnessAction,
    imageUpdateAction: actions.imageUpdateAction
}));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    listDeploymentsAction: actions.listDeploymentsAction,
    databaseConnectionAction: actions.databaseConnectionAction,
    listDatabaseInstancesAction: actions.listDatabaseInstancesAction,
    serviceFollowStateAction: actions.serviceFollowStateAction,
    serviceHistoryAction: actions.serviceHistoryAction,
    listDeployServersAction: actions.listDeployServersAction,
    quickTunnelStatusAction: actions.quickTunnelStatusAction,
    ngrokTunnelStatusAction: actions.ngrokTunnelStatusAction,
    namedTunnelStatusAction: actions.namedTunnelStatusAction,
    domainHealthAction: actions.domainHealthAction,
    cloudflareAccountStatusAction: actions.cloudflareAccountStatusAction,
    listNasConnectionsAction: actions.listNasConnectionsAction
}));
vi.mock("@/app/(app)/apps/deploy/project-actions", () => ({
    listPromotionsAction: actions.listPromotionsAction,
    previewPromotionAction: actions.previewPromotionAction,
    volumeDetailAction: actions.volumeDetailAction
}));
vi.mock("@/app/(app)/apps/servers/actions", () => ({
    serverEdgeAction: actions.serverEdgeAction,
    enrollmentStatusAction: actions.enrollmentStatusAction
}));
vi.mock("@/app/(app)/apps/agents/sessions/actions", () => ({
    sessionScreenAction: actions.sessionScreenAction
}));
vi.mock("@/app/(app)/apps/network-filter/actions", () => ({
    dnsInsightsAction: actions.dnsInsightsAction,
    dnsTailAction: actions.dnsTailAction
}));
vi.mock("@/app/(app)/apps/tunnels/actions", () => ({
    tunnelStatusesAction: actions.tunnelStatusesAction
}));
vi.mock("@/app/(app)/home/app-widget-actions", () => ({
    readAppWidgetsAction: actions.readAppWidgetsAction
}));
vi.mock("@/app/(app)/admin/inbox/actions", () => ({
    listConversationsAction: actions.listConversationsAction,
    getMessagesAction: actions.getMessagesAction,
    listActivityAction: actions.listActivityAction,
    channelStateAction: actions.channelStateAction
}));
vi.mock("@/app/(app)/apps/mail-server/actions", () => ({
    serverDetailAction: actions.serverDetailAction
}));
vi.mock("@/app/(app)/automations/actions", () => ({ getRunAction: actions.getRunAction }));
vi.mock("@/app/(app)/admin/settings/actions", () => ({
    checkUpdatesAction: actions.checkUpdatesAction
}));
vi.mock("@/app/(app)/account/domains/actions", () => ({
    readOwnerDomainAction: actions.readOwnerDomainAction
}));
vi.mock("@/app/(app)/account/domains/dns-actions", () => ({
    dnsPropagationAction: actions.dnsPropagationAction
}));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({ readCallAction: actions.readCallAction }));
vi.mock("@/app/oauth/recover/actions", () => ({
    recoveryStatusAction: actions.recoveryStatusAction
}));
vi.mock("@/app/(app)/apps/deploy/source-actions", () => ({
    buildMachineAction: actions.buildMachineAction,
    serviceSourceAction: actions.serviceSourceAction,
    uploadedSourceAction: actions.uploadedSourceAction
}));
vi.mock("@/app/(app)/apps/deploy/cron-actions", () => ({
    listServiceCronRunsAction: actions.listServiceCronRunsAction
}));
vi.mock("@/app/(app)/apps/deploy/deploy-behaviour-actions", () => ({
    deployBehaviourAction: actions.deployBehaviourAction
}));
vi.mock("@/app/(app)/apps/deploy/gpu-actions", () => ({
    serviceGpuAction: actions.serviceGpuAction
}));
vi.mock("@/app/(app)/apps/deploy/fix-actions", () => ({
    deploymentDiagnosisAction: actions.deploymentDiagnosisAction
}));
vi.mock("@/app/(app)/apps/deploy/public-networking-actions", () => ({
    servicePortsAction: actions.servicePortsAction,
    domainReadingsAction: actions.domainReadingsAction,
    tcpProxiesAction: actions.tcpProxiesAction
}));
vi.mock("@/app/(app)/apps/deploy/scaling-actions", () => ({
    serviceScalingAction: actions.serviceScalingAction
}));
vi.mock("@/app/(app)/apps/deploy/automation-actions", () => ({
    listAutomationRunsAction: actions.listAutomationRunsAction
}));
vi.mock("@/app/(app)/apps/deploy/variable-group-actions", () => ({
    variableGroupReachAction: actions.variableGroupReachAction,
    serviceTagsAction: actions.serviceTagsAction
}));
vi.mock("@/app/(app)/apps/deploy/variable-actions", () => ({
    revealEnvScopeAction: actions.revealEnvScopeAction
}));

type Handler = (request: Request) => Promise<Response>;

const ROUTES: Record<string, () => Promise<{ GET: Handler }>> = {
    "/api/deploy/databases/overview": () => import("@/app/api/deploy/databases/overview/route"),
    "/api/deploy/databases/processes": () => import("@/app/api/deploy/databases/processes/route"),
    "/api/deploy/cutover": () => import("@/app/api/deploy/cutover/route"),
    "/api/deploy/external-services/status": () =>
        import("@/app/api/deploy/external-services/status/route"),
    "/api/deploy/projects/glance": () => import("@/app/api/deploy/projects/glance/route"),
    "/api/deploy/freshness": () => import("@/app/api/deploy/freshness/route"),
    "/api/deploy/image-update": () => import("@/app/api/deploy/image-update/route"),
    "/api/deploy/deployments": () => import("@/app/api/deploy/deployments/route"),
    "/api/deploy/promotions": () => import("@/app/api/deploy/promotions/route"),
    "/api/servers/edge": () => import("@/app/api/servers/edge/route"),
    "/api/servers/enrollment-status": () => import("@/app/api/servers/enrollment-status/route"),
    "/api/agents/sessions/screen": () => import("@/app/api/agents/sessions/screen/route"),
    "/api/dns-blocker/insights": () => import("@/app/api/dns-blocker/insights/route"),
    "/api/dns-blocker/tail": () => import("@/app/api/dns-blocker/tail/route"),
    "/api/tunnels/statuses": () => import("@/app/api/tunnels/statuses/route"),
    "/api/home/app-widgets": () => import("@/app/api/home/app-widgets/route"),
    "/api/inbox/conversations": () => import("@/app/api/inbox/conversations/route"),
    "/api/inbox/messages": () => import("@/app/api/inbox/messages/route"),
    "/api/inbox/activity": () => import("@/app/api/inbox/activity/route"),
    "/api/inbox/channel-state": () => import("@/app/api/inbox/channel-state/route"),
    "/api/mail-server/detail": () => import("@/app/api/mail-server/detail/route"),
    "/api/automations/run": () => import("@/app/api/automations/run/route"),
    "/api/admin/settings/update-status": () =>
        import("@/app/api/admin/settings/update-status/route"),
    "/api/domains/owner-domain": () => import("@/app/api/domains/owner-domain/route"),
    "/api/domains/dns-propagation": () => import("@/app/api/domains/dns-propagation/route"),
    "/api/guest-call": () => import("@/app/api/guest-call/route"),
    "/api/account-recovery/status": () => import("@/app/api/account-recovery/status/route"),
    "/api/deploy/services/build-machine": () =>
        import("@/app/api/deploy/services/build-machine/route"),
    "/api/deploy/services/cron-runs": () => import("@/app/api/deploy/services/cron-runs/route"),
    "/api/deploy/services/deploy-behaviour": () =>
        import("@/app/api/deploy/services/deploy-behaviour/route"),
    "/api/deploy/databases/connection": () => import("@/app/api/deploy/databases/connection/route"),
    "/api/deploy/databases/instances": () => import("@/app/api/deploy/databases/instances/route"),
    "/api/deploy/providers/choices": () => import("@/app/api/deploy/providers/choices/route"),
    "/api/deploy/providers/accounts": () => import("@/app/api/deploy/providers/accounts/route"),
    "/api/deploy/move/out-plan": () => import("@/app/api/deploy/move/out-plan/route"),
    "/api/deploy/move/home-plan": () => import("@/app/api/deploy/move/home-plan/route"),
    "/api/deploy/services/gpu": () => import("@/app/api/deploy/services/gpu/route"),
    "/api/deploy/deployments/diagnosis": () =>
        import("@/app/api/deploy/deployments/diagnosis/route"),
    "/api/deploy/services/ports": () => import("@/app/api/deploy/services/ports/route"),
    "/api/deploy/services/domain-readings": () =>
        import("@/app/api/deploy/services/domain-readings/route"),
    "/api/deploy/services/tcp-proxies": () => import("@/app/api/deploy/services/tcp-proxies/route"),
    "/api/deploy/services/scaling": () => import("@/app/api/deploy/services/scaling/route"),
    "/api/deploy/services/follow-state": () =>
        import("@/app/api/deploy/services/follow-state/route"),
    "/api/deploy/services/history": () => import("@/app/api/deploy/services/history/route"),
    "/api/deploy/servers": () => import("@/app/api/deploy/servers/route"),
    "/api/deploy/services/quick-tunnel": () =>
        import("@/app/api/deploy/services/quick-tunnel/route"),
    "/api/deploy/services/ngrok-tunnel": () =>
        import("@/app/api/deploy/services/ngrok-tunnel/route"),
    "/api/deploy/services/named-tunnel": () =>
        import("@/app/api/deploy/services/named-tunnel/route"),
    "/api/deploy/services/domain-health": () =>
        import("@/app/api/deploy/services/domain-health/route"),
    "/api/deploy/cloudflare/account-status": () =>
        import("@/app/api/deploy/cloudflare/account-status/route"),
    "/api/deploy/services/source": () => import("@/app/api/deploy/services/source/route"),
    "/api/deploy/services/uploaded-source": () =>
        import("@/app/api/deploy/services/uploaded-source/route"),
    "/api/deploy/automations/runs": () => import("@/app/api/deploy/automations/runs/route"),
    "/api/deploy/promotions/preview": () => import("@/app/api/deploy/promotions/preview/route"),
    "/api/deploy/volumes/detail": () => import("@/app/api/deploy/volumes/detail/route"),
    "/api/deploy/variable-groups/reach": () =>
        import("@/app/api/deploy/variable-groups/reach/route"),
    "/api/deploy/services/tags": () => import("@/app/api/deploy/services/tags/route"),
    "/api/deploy/variables/reveal": () => import("@/app/api/deploy/variables/reveal/route"),
    "/api/deploy/nas-connections": () => import("@/app/api/deploy/nas-connections/route")
};

const actual = <T>(path: string) => vi.importActual<T>(path);
const deploy = () =>
    actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
        "@/app/(app)/apps/deploy/deploy-polls"
    );
const servers = () =>
    actual<typeof import("@/app/(app)/apps/servers/servers-polls")>(
        "@/app/(app)/apps/servers/servers-polls"
    );
const dns = () =>
    actual<typeof import("@/app/(app)/apps/network-filter/dns-blocker-polls")>(
        "@/app/(app)/apps/network-filter/dns-blocker-polls"
    );
const inbox = () =>
    actual<typeof import("@/app/(app)/admin/inbox/inbox-polls")>(
        "@/app/(app)/admin/inbox/inbox-polls"
    );
const domains = () =>
    actual<typeof import("@/app/(app)/account/domains/domains-polls")>(
        "@/app/(app)/account/domains/domains-polls"
    );

const ID = "4f0c1c6e-6f0e-4d2a-9a51-2a3f1f6c9d10";
const OTHER = "0b8f3a52-2c1e-4f7a-8d3b-6e5a4c3b2a19";
const FILTER = {
    search: "example.com",
    outcome: "blocked",
    client: "10.0.0.5",
    type: "AAAA",
    range: "24h",
    page: 2
};

type Case = {
    name: string;
    path: string;
    ask: () => Promise<unknown>;
    action: keyof typeof actions;
    args: unknown[];
};

const CASES: Case[] = [
    {
        name: "a database's overview",
        path: "/api/deploy/databases/overview",
        ask: async () => (await deploy()).databaseOverview(ID),
        action: "databaseOverviewAction",
        args: [ID]
    },
    {
        name: "a database's processes",
        path: "/api/deploy/databases/processes",
        ask: async () => (await deploy()).databaseProcesses(ID),
        action: "listDatabaseProcessesAction",
        args: [ID]
    },
    {
        name: "a domain's cutover panel",
        path: "/api/deploy/cutover",
        ask: async () => (await deploy()).cutoverPanel(ID),
        action: "cutoverPanelAction",
        args: [ID]
    },
    {
        name: "an outside service's status",
        path: "/api/deploy/external-services/status",
        ask: async () => (await deploy()).externalServiceStatus("project-1", ID),
        action: "refreshExternalServiceAction",
        args: ["project-1", ID]
    },
    {
        name: "a project's glance",
        path: "/api/deploy/projects/glance",
        ask: async () => (await deploy()).projectGlance("project-1"),
        action: "projectGlanceAction",
        args: ["project-1"]
    },
    {
        name: "a service's freshness against its branch",
        path: "/api/deploy/freshness",
        ask: async () => (await deploy()).deployFreshness("app-1"),
        action: "deployFreshnessAction",
        args: ["app-1"]
    },
    {
        name: "a service's newer image",
        path: "/api/deploy/image-update",
        ask: async () => (await deploy()).imageUpdate("app-1"),
        action: "imageUpdateAction",
        args: ["app-1"]
    },
    {
        name: "a service's deployments",
        path: "/api/deploy/deployments",
        ask: async () => (await deploy()).deployments("app-1"),
        action: "listDeploymentsAction",
        args: ["app-1"]
    },
    {
        name: "a project's promotions",
        path: "/api/deploy/promotions",
        ask: async () => (await deploy()).promotions("project-1"),
        action: "listPromotionsAction",
        args: ["project-1"]
    },
    {
        name: "a server's edge",
        path: "/api/servers/edge",
        ask: async () => (await servers()).serverEdge("host-1"),
        action: "serverEdgeAction",
        args: ["host-1"]
    },
    {
        name: "an enrollment's status",
        path: "/api/servers/enrollment-status",
        ask: async () => (await servers()).enrollmentStatus("enroll-1"),
        action: "enrollmentStatusAction",
        args: ["enroll-1"]
    },
    {
        name: "an agent session's screen",
        path: "/api/agents/sessions/screen",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/agents/sessions/sessions-polls")>(
                    "@/app/(app)/apps/agents/sessions/sessions-polls"
                )
            ).sessionScreen("session-1"),
        action: "sessionScreenAction",
        args: ["session-1"]
    },
    {
        name: "the DNS insights, asked fresh",
        path: "/api/dns-blocker/insights",
        ask: async () => (await dns()).dnsInsights(FILTER, true),
        action: "dnsInsightsAction",
        args: [FILTER, true]
    },
    {
        name: "the DNS insights, from cache",
        path: "/api/dns-blocker/insights",
        ask: async () => (await dns()).dnsInsights(FILTER, false),
        action: "dnsInsightsAction",
        args: [FILTER, false]
    },
    {
        name: "the DNS live tail",
        path: "/api/dns-blocker/tail",
        ask: async () => (await dns()).dnsTail(FILTER),
        action: "dnsTailAction",
        args: [FILTER]
    },
    {
        name: "the tunnels' statuses",
        path: "/api/tunnels/statuses",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/tunnels/tunnels-polls")>(
                    "@/app/(app)/apps/tunnels/tunnels-polls"
                )
            ).tunnelStatuses([ID, OTHER]),
        action: "tunnelStatusesAction",
        args: [{ ids: [ID, OTHER] }]
    },
    {
        name: "the Overview's app cards",
        path: "/api/home/app-widgets",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/home/home-polls")>(
                    "@/app/(app)/home/home-polls"
                )
            ).appWidgets(),
        action: "readAppWidgetsAction",
        args: []
    },
    {
        name: "the Inbox's conversations",
        path: "/api/inbox/conversations",
        ask: async () => (await inbox()).conversations(),
        action: "listConversationsAction",
        args: []
    },
    {
        name: "a conversation's messages",
        path: "/api/inbox/messages",
        ask: async () => (await inbox()).messages("conversation-1"),
        action: "getMessagesAction",
        args: ["conversation-1"]
    },
    {
        name: "the Inbox's log",
        path: "/api/inbox/activity",
        ask: async () => (await inbox()).activity(),
        action: "listActivityAction",
        args: []
    },
    {
        name: "a channel's state",
        path: "/api/inbox/channel-state",
        ask: async () => (await inbox()).channelState("channel-1"),
        action: "channelStateAction",
        args: ["channel-1"]
    },
    {
        name: "a mail server's detail",
        path: "/api/mail-server/detail",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/mail-server/mail-server-polls")>(
                    "@/app/(app)/apps/mail-server/mail-server-polls"
                )
            ).serverDetail("mail-1"),
        action: "serverDetailAction",
        args: ["mail-1"]
    },
    {
        name: "an automation run",
        path: "/api/automations/run",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/automations/automations-polls")>(
                    "@/app/(app)/automations/automations-polls"
                )
            ).run("run-1"),
        action: "getRunAction",
        args: ["run-1"]
    },
    {
        name: "the update status, forced",
        path: "/api/admin/settings/update-status",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/admin/settings/settings-polls")>(
                    "@/app/(app)/admin/settings/settings-polls"
                )
            ).updateStatus(true),
        action: "checkUpdatesAction",
        args: [true]
    },
    {
        name: "the update status, not forced",
        path: "/api/admin/settings/update-status",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/admin/settings/settings-polls")>(
                    "@/app/(app)/admin/settings/settings-polls"
                )
            ).updateStatus(false),
        action: "checkUpdatesAction",
        args: [false]
    },
    {
        name: "a personal domain",
        path: "/api/domains/owner-domain",
        ask: async () => (await domains()).ownerDomain({ kind: "user" }, "domain-1"),
        action: "readOwnerDomainAction",
        args: [{ kind: "user" }, "domain-1"]
    },
    {
        name: "an organization's domain",
        path: "/api/domains/owner-domain",
        ask: async () => (await domains()).ownerDomain({ kind: "org", orgId: ID }, "domain-1"),
        action: "readOwnerDomainAction",
        args: [{ kind: "org", orgId: ID }, "domain-1"]
    },
    {
        name: "a record's propagation on the instance zone",
        path: "/api/domains/dns-propagation",
        ask: async () =>
            (await domains()).dnsPropagation({ kind: "instance", zoneId: "zone-1" }, "record-1"),
        action: "dnsPropagationAction",
        args: [{ kind: "instance", zoneId: "zone-1" }, "record-1"]
    },
    {
        name: "a record's propagation on a domain of one's own",
        path: "/api/domains/dns-propagation",
        ask: async () =>
            (await domains()).dnsPropagation(
                { kind: "owner", ref: { kind: "org", orgId: ID }, domainId: OTHER },
                "record-1"
            ),
        action: "dnsPropagationAction",
        args: [{ kind: "owner", ref: { kind: "org", orgId: ID }, domainId: OTHER }, "record-1"]
    },
    {
        name: "a guest's call",
        path: "/api/guest-call",
        ask: async () =>
            (
                await actual<typeof import("@/app/m/[token]/guest-polls")>(
                    "@/app/m/[token]/guest-polls"
                )
            ).guestCall("meeting-1"),
        action: "readCallAction",
        args: ["meeting-1"]
    },
    {
        name: "a recovery request's status",
        path: "/api/account-recovery/status",
        ask: async () =>
            (
                await actual<typeof import("@/app/oauth/recover/recover-polls")>(
                    "@/app/oauth/recover/recover-polls"
                )
            ).recoveryStatus("ticket-1"),
        action: "recoveryStatusAction",
        args: ["ticket-1"]
    },
    {
        name: "a service's build machine",
        path: "/api/deploy/services/build-machine",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).buildMachine("applicationId-1"),
        action: "buildMachineAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service cron's runs",
        path: "/api/deploy/services/cron-runs",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).serviceCronRuns("applicationId-1", "cronId-1"),
        action: "listServiceCronRunsAction",
        args: ["applicationId-1", "cronId-1"]
    },
    {
        name: "a service's deploy behaviour",
        path: "/api/deploy/services/deploy-behaviour",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).deployBehaviour("applicationId-1"),
        action: "deployBehaviourAction",
        args: ["applicationId-1"]
    },
    {
        name: "a database's connection details",
        path: "/api/deploy/databases/connection",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).databaseConnection("databaseId-1"),
        action: "databaseConnectionAction",
        args: ["databaseId-1"]
    },
    {
        name: "an environment's database instances",
        path: "/api/deploy/databases/instances",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).databaseInstances("environmentId-1", "engine-1"),
        action: "listDatabaseInstancesAction",
        args: ["environmentId-1", "engine-1"]
    },
    {
        name: "what a provider account can deploy into",
        path: "/api/deploy/providers/choices",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).providerChoices("connectionId-1"),
        action: "listProviderChoicesAction",
        args: ["connectionId-1"]
    },
    {
        name: "the provider accounts one has linked",
        path: "/api/deploy/providers/accounts",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).providerAccounts(),
        action: "listProviderAccountsAction",
        args: []
    },
    {
        name: "the plan for moving a service out",
        path: "/api/deploy/move/out-plan",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).moveOutPlan("projectId-1", "applicationId-1"),
        action: "moveOutPlanAction",
        args: ["projectId-1", "applicationId-1"]
    },
    {
        name: "the plan for moving a service home",
        path: "/api/deploy/move/home-plan",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).moveHomePlan("projectId-1", "serviceId-1"),
        action: "moveHomePlanAction",
        args: ["projectId-1", "serviceId-1"]
    },
    {
        name: "a service's GPU",
        path: "/api/deploy/services/gpu",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).serviceGpu("applicationId-1"),
        action: "serviceGpuAction",
        args: ["applicationId-1"]
    },
    {
        name: "a failed deployment's likely cause",
        path: "/api/deploy/deployments/diagnosis",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).deploymentDiagnosis("deploymentId-1"),
        action: "deploymentDiagnosisAction",
        args: ["deploymentId-1"]
    },
    {
        name: "a service's ports",
        path: "/api/deploy/services/ports",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).servicePorts("applicationId-1"),
        action: "servicePortsAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service's domain readings",
        path: "/api/deploy/services/domain-readings",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).domainReadings("applicationId-1"),
        action: "domainReadingsAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service's TCP proxies",
        path: "/api/deploy/services/tcp-proxies",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).tcpProxies("applicationId-1"),
        action: "tcpProxiesAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service's scaling",
        path: "/api/deploy/services/scaling",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).serviceScaling("applicationId-1"),
        action: "serviceScalingAction",
        args: ["applicationId-1"]
    },
    {
        name: "whether one follows a service",
        path: "/api/deploy/services/follow-state",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).serviceFollowState("applicationId-1"),
        action: "serviceFollowStateAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service's history",
        path: "/api/deploy/services/history",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).serviceHistory("applicationId-1"),
        action: "serviceHistoryAction",
        args: ["applicationId-1"]
    },
    {
        name: "the machines a service can deploy to",
        path: "/api/deploy/servers",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).deployServers("environmentId-1"),
        action: "listDeployServersAction",
        args: ["environmentId-1"]
    },
    {
        name: "a service's quick tunnel",
        path: "/api/deploy/services/quick-tunnel",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).quickTunnelStatus("applicationId-1"),
        action: "quickTunnelStatusAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service's ngrok tunnel",
        path: "/api/deploy/services/ngrok-tunnel",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).ngrokTunnelStatus("applicationId-1"),
        action: "ngrokTunnelStatusAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service's named tunnel",
        path: "/api/deploy/services/named-tunnel",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).namedTunnelStatus("applicationId-1"),
        action: "namedTunnelStatusAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service's domain health",
        path: "/api/deploy/services/domain-health",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).domainHealth("applicationId-1"),
        action: "domainHealthAction",
        args: ["applicationId-1"]
    },
    {
        name: "whether a Cloudflare account is connected",
        path: "/api/deploy/cloudflare/account-status",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).cloudflareAccountStatus(),
        action: "cloudflareAccountStatusAction",
        args: []
    },
    {
        name: "a service's source",
        path: "/api/deploy/services/source",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).serviceSource("applicationId-1"),
        action: "serviceSourceAction",
        args: ["applicationId-1"]
    },
    {
        name: "a service's uploaded source",
        path: "/api/deploy/services/uploaded-source",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).uploadedSource("applicationId-1"),
        action: "uploadedSourceAction",
        args: ["applicationId-1"]
    },
    {
        name: "a project automation's runs",
        path: "/api/deploy/automations/runs",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).automationRuns({ projectId: "projectId-1", automationId: "automationId-1" }),
        action: "listAutomationRunsAction",
        args: [{ projectId: "projectId-1", automationId: "automationId-1" }]
    },
    {
        name: "what a promotion would change",
        path: "/api/deploy/promotions/preview",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).promotionPreview({
                sourceEnvironmentId: "sourceEnvironmentId-1",
                targetEnvironmentId: "targetEnvironmentId-1"
            }),
        action: "previewPromotionAction",
        args: [
            {
                sourceEnvironmentId: "sourceEnvironmentId-1",
                targetEnvironmentId: "targetEnvironmentId-1"
            }
        ]
    },
    {
        name: "a volume's detail",
        path: "/api/deploy/volumes/detail",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).volumeDetail("volumeId-1"),
        action: "volumeDetailAction",
        args: ["volumeId-1"]
    },
    {
        name: "how far a variable group reaches",
        path: "/api/deploy/variable-groups/reach",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).variableGroupReach({ groupId: "groupId-1" }),
        action: "variableGroupReachAction",
        args: [{ groupId: "groupId-1" }]
    },
    {
        name: "a service's tags",
        path: "/api/deploy/services/tags",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).serviceTags({ applicationId: "applicationId-1" }),
        action: "serviceTagsAction",
        args: [{ applicationId: "applicationId-1" }]
    },
    {
        name: "a scope's variables, shown in the raw editor",
        path: "/api/deploy/variables/reveal",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).envScopeValues({ scope: "scope-1", scopeId: "scopeId-1" }),
        action: "revealEnvScopeAction",
        args: [{ scope: "scope-1", scopeId: "scopeId-1" }]
    },
    {
        name: "the NAS connections a volume can use",
        path: "/api/deploy/nas-connections",
        ask: async () =>
            (
                await actual<typeof import("@/app/(app)/apps/deploy/deploy-polls")>(
                    "@/app/(app)/apps/deploy/deploy-polls"
                )
            ).nasConnections(),
        action: "listNasConnectionsAction",
        args: []
    }
];

beforeEach(() => {
    vi.unstubAllGlobals();
    session.backgroundUser.mockResolvedValue({ id: "user-1" });
    admin.apiAdmin.mockResolvedValue({ id: "user-1", isAdmin: true });
    for (const spy of Object.values(actions)) spy.mockReset();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            const request = new Request(`http://polaris.test${url}`);
            const load = ROUTES[new URL(request.url).pathname];
            if (!load) return new Response("{}", { status: 404 });
            return (await load()).GET(request);
        })
    );
});

describe("each screen poll through its route", () => {
    it("covers every route the polls ask", () => {
        expect(new Set(CASES.map((entry) => entry.path))).toEqual(new Set(Object.keys(ROUTES)));
    });

    it.each(CASES)("$name reaches its action with what the screen asked", async (entry) => {
        const answer = { ok: true, at: new Date("2026-10-19T10:00:00Z") };
        actions[entry.action].mockResolvedValue(answer);
        await expect(entry.ask()).resolves.toEqual(answer);
        expect(actions[entry.action]).toHaveBeenCalledTimes(1);
        expect(actions[entry.action]).toHaveBeenCalledWith(...entry.args);
    });
});
