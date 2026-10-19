// The screens' timed reads go through routes (see `lib/poll-route`), each of
// which runs the server action the screen used to call. The screen tests drive
// what those reads return by mocking the action modules, so each poll module is
// replaced here by one that forwards to whatever the test file has for that
// action - mocked or not, exactly what the screen called before. The routes
// themselves are tested on their own.
import { vi } from "vitest";

type Loader = () => Promise<unknown>;

/** Call `name` from the module `load` imports, with the first `arity` arguments
 *  (the poll's trailing abort signal is not the action's). */
function forward(load: Loader, name: string, arity: number) {
    return async (...args: unknown[]) => {
        const loaded = (await load()) as Record<string, (...args: unknown[]) => unknown>;
        return loaded[name](...args.slice(0, arity));
    };
}

vi.mock("@/app/(app)/apps/deploy/deploy-polls", () => {
    const databases = () => import("@/app/(app)/apps/deploy/database-actions");
    return {
        databaseOverview: forward(databases, "databaseOverviewAction", 1),
        databaseProcesses: forward(databases, "listDatabaseProcessesAction", 1),
        cutoverPanel: forward(
            () => import("@/app/(app)/apps/deploy/dns-cutover-actions"),
            "cutoverPanelAction",
            1
        ),
        externalServiceStatus: forward(
            () => import("@/app/(app)/apps/deploy/external-actions"),
            "refreshExternalServiceAction",
            2
        ),
        projectGlance: forward(
            () => import("@/app/(app)/apps/deploy/glance-actions"),
            "projectGlanceAction",
            1
        ),
        deployments: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "listDeploymentsAction",
            1
        ),
        promotions: forward(
            () => import("@/app/(app)/apps/deploy/project-actions"),
            "listPromotionsAction",
            1
        )
    };
});

vi.mock("@/app/(app)/apps/servers/servers-polls", () => ({
    serverEdge: forward(() => import("@/app/(app)/apps/servers/actions"), "serverEdgeAction", 1),
    enrollmentStatus: forward(
        () => import("@/app/(app)/apps/servers/actions"),
        "enrollmentStatusAction",
        1
    )
}));

vi.mock("@/app/(app)/apps/agents/sessions/sessions-polls", () => ({
    sessionScreen: forward(
        () => import("@/app/(app)/apps/agents/sessions/actions"),
        "sessionScreenAction",
        1
    )
}));

vi.mock("@/app/(app)/apps/dns-blocker/dns-blocker-polls", () => {
    const actions = () => import("@/app/(app)/apps/dns-blocker/actions");
    return {
        dnsInsights: forward(actions, "dnsInsightsAction", 2),
        dnsTail: forward(actions, "dnsTailAction", 1)
    };
});

vi.mock("@/app/(app)/apps/tunnels/tunnels-polls", () => ({
    // The action takes `{ ids }`; the poll takes the ids.
    tunnelStatuses: async (ids: readonly string[]) => {
        const actions = await import("@/app/(app)/apps/tunnels/actions");
        return actions.tunnelStatusesAction({ ids: [...ids] });
    }
}));

vi.mock("@/app/(app)/home/home-polls", () => ({
    appWidgets: forward(
        () => import("@/app/(app)/home/app-widget-actions"),
        "readAppWidgetsAction",
        0
    )
}));

vi.mock("@/app/(app)/admin/inbox/inbox-polls", () => {
    const actions = () => import("@/app/(app)/admin/inbox/actions");
    return {
        conversations: forward(actions, "listConversationsAction", 0),
        messages: forward(actions, "getMessagesAction", 1),
        activity: forward(actions, "listActivityAction", 0),
        channelState: forward(actions, "channelStateAction", 1)
    };
});

vi.mock("@/app/(app)/apps/mail-server/mail-server-polls", () => ({
    serverDetail: forward(
        () => import("@/app/(app)/apps/mail-server/actions"),
        "serverDetailAction",
        1
    )
}));

vi.mock("@/app/(app)/automations/automations-polls", () => ({
    run: forward(() => import("@/app/(app)/automations/actions"), "getRunAction", 1)
}));

vi.mock("@/app/(app)/admin/settings/settings-polls", () => ({
    updateStatus: forward(
        () => import("@/app/(app)/admin/settings/actions"),
        "checkUpdatesAction",
        1
    )
}));

vi.mock("@/app/(app)/account/domains/domains-polls", () => ({
    ownerDomain: forward(
        () => import("@/app/(app)/account/domains/actions"),
        "readOwnerDomainAction",
        2
    ),
    dnsPropagation: forward(
        () => import("@/app/(app)/account/domains/dns-actions"),
        "dnsPropagationAction",
        2
    )
}));

vi.mock("@/app/m/[token]/guest-polls", () => ({
    guestCall: forward(() => import("@/app/(app)/chat/meeting-actions"), "readCallAction", 1)
}));

vi.mock("@/app/oauth/recover/recover-polls", () => ({
    recoveryStatus: forward(() => import("@/app/oauth/recover/actions"), "recoveryStatusAction", 1)
}));
