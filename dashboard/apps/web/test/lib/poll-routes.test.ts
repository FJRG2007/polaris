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
        "recoveryStatusAction"
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
    refreshExternalServiceAction: actions.refreshExternalServiceAction
}));
vi.mock("@/app/(app)/apps/deploy/glance-actions", () => ({
    projectGlanceAction: actions.projectGlanceAction
}));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    listDeploymentsAction: actions.listDeploymentsAction
}));
vi.mock("@/app/(app)/apps/deploy/project-actions", () => ({
    listPromotionsAction: actions.listPromotionsAction
}));
vi.mock("@/app/(app)/apps/servers/actions", () => ({
    serverEdgeAction: actions.serverEdgeAction,
    enrollmentStatusAction: actions.enrollmentStatusAction
}));
vi.mock("@/app/(app)/apps/agents/sessions/actions", () => ({
    sessionScreenAction: actions.sessionScreenAction
}));
vi.mock("@/app/(app)/apps/dns-blocker/actions", () => ({
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

type Handler = (request: Request) => Promise<Response>;

const ROUTES: Record<string, () => Promise<{ GET: Handler }>> = {
    "/api/deploy/databases/overview": () => import("@/app/api/deploy/databases/overview/route"),
    "/api/deploy/databases/processes": () => import("@/app/api/deploy/databases/processes/route"),
    "/api/deploy/cutover": () => import("@/app/api/deploy/cutover/route"),
    "/api/deploy/external-services/status": () =>
        import("@/app/api/deploy/external-services/status/route"),
    "/api/deploy/projects/glance": () => import("@/app/api/deploy/projects/glance/route"),
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
    "/api/account-recovery/status": () => import("@/app/api/account-recovery/status/route")
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
    actual<typeof import("@/app/(app)/apps/dns-blocker/dns-blocker-polls")>(
        "@/app/(app)/apps/dns-blocker/dns-blocker-polls"
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
