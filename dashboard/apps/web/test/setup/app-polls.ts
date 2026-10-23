// The screens' timed reads go through routes (see `lib/poll-route`), each of
// which runs the server action the screen used to call. The screen tests drive
// what those reads return by mocking the action modules, so each poll module is
// replaced here by one that forwards to whatever the test file has for that
// action - mocked or not, exactly what the screen called before. The routes
// themselves are tested on their own.
import { vi } from "vitest";

type Loader = () => Promise<unknown>;

/** Imports already under way, by loader. Two first imports of a mocked module at
 *  the same moment hand one of them the real module, so a screen that asks two
 *  reads at once would reach the server code; the second waits on the first. */
const loading = new Map<Loader, Promise<unknown>>();

function loadOnce(load: Loader): Promise<unknown> {
    const pending = loading.get(load);
    if (pending) return pending;
    const started = load().finally(() => loading.delete(load));
    loading.set(load, started);
    return started;
}

/** Call `name` from the module `load` imports, with the first `arity` arguments
 *  (the poll's trailing abort signal is not the action's). */
function forward(load: Loader, name: string, arity: number) {
    return async (...args: unknown[]) => {
        const loaded = (await loadOnce(load)) as Record<string, (...args: unknown[]) => unknown>;
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
        ),
        buildMachine: forward(
            () => import("@/app/(app)/apps/deploy/source-actions"),
            "buildMachineAction",
            1
        ),
        serviceCronRuns: forward(
            () => import("@/app/(app)/apps/deploy/cron-actions"),
            "listServiceCronRunsAction",
            2
        ),
        deployBehaviour: forward(
            () => import("@/app/(app)/apps/deploy/deploy-behaviour-actions"),
            "deployBehaviourAction",
            1
        ),
        databaseConnection: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "databaseConnectionAction",
            1
        ),
        databaseInstances: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "listDatabaseInstancesAction",
            2
        ),
        providerChoices: forward(
            () => import("@/app/(app)/apps/deploy/external-actions"),
            "listProviderChoicesAction",
            1
        ),
        providerAccounts: forward(
            () => import("@/app/(app)/apps/deploy/external-actions"),
            "listProviderAccountsAction",
            0
        ),
        moveOutPlan: forward(
            () => import("@/app/(app)/apps/deploy/external-actions"),
            "moveOutPlanAction",
            2
        ),
        moveHomePlan: forward(
            () => import("@/app/(app)/apps/deploy/external-actions"),
            "moveHomePlanAction",
            2
        ),
        serviceGpu: forward(
            () => import("@/app/(app)/apps/deploy/gpu-actions"),
            "serviceGpuAction",
            1
        ),
        deploymentDiagnosis: forward(
            () => import("@/app/(app)/apps/deploy/fix-actions"),
            "deploymentDiagnosisAction",
            1
        ),
        servicePorts: forward(
            () => import("@/app/(app)/apps/deploy/public-networking-actions"),
            "servicePortsAction",
            1
        ),
        domainReadings: forward(
            () => import("@/app/(app)/apps/deploy/public-networking-actions"),
            "domainReadingsAction",
            1
        ),
        tcpProxies: forward(
            () => import("@/app/(app)/apps/deploy/public-networking-actions"),
            "tcpProxiesAction",
            1
        ),
        serviceScaling: forward(
            () => import("@/app/(app)/apps/deploy/scaling-actions"),
            "serviceScalingAction",
            1
        ),
        serviceFollowState: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "serviceFollowStateAction",
            1
        ),
        serviceHistory: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "serviceHistoryAction",
            1
        ),
        deployServers: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "listDeployServersAction",
            1
        ),
        quickTunnelStatus: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "quickTunnelStatusAction",
            1
        ),
        ngrokTunnelStatus: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "ngrokTunnelStatusAction",
            1
        ),
        namedTunnelStatus: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "namedTunnelStatusAction",
            1
        ),
        domainHealth: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "domainHealthAction",
            1
        ),
        cloudflareAccountStatus: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "cloudflareAccountStatusAction",
            0
        ),
        serviceSource: forward(
            () => import("@/app/(app)/apps/deploy/source-actions"),
            "serviceSourceAction",
            1
        ),
        uploadedSource: forward(
            () => import("@/app/(app)/apps/deploy/source-actions"),
            "uploadedSourceAction",
            1
        ),
        automationRuns: forward(
            () => import("@/app/(app)/apps/deploy/automation-actions"),
            "listAutomationRunsAction",
            1
        ),
        promotionPreview: forward(
            () => import("@/app/(app)/apps/deploy/project-actions"),
            "previewPromotionAction",
            1
        ),
        volumeDetail: forward(
            () => import("@/app/(app)/apps/deploy/project-actions"),
            "volumeDetailAction",
            1
        ),
        variableGroupReach: forward(
            () => import("@/app/(app)/apps/deploy/variable-group-actions"),
            "variableGroupReachAction",
            1
        ),
        serviceTags: forward(
            () => import("@/app/(app)/apps/deploy/variable-group-actions"),
            "serviceTagsAction",
            1
        ),
        envScopeValues: forward(
            () => import("@/app/(app)/apps/deploy/variable-actions"),
            "revealEnvScopeAction",
            1
        ),
        nasConnections: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "listNasConnectionsAction",
            0
        )
    };
});

vi.mock("@/app/(app)/apps/servers/servers-polls", () => ({
    serverEdge: forward(() => import("@/app/(app)/apps/servers/actions"), "serverEdgeAction", 1),
    enrollmentStatus: forward(
        () => import("@/app/(app)/apps/servers/actions"),
        "enrollmentStatusAction",
        1
    ),
    removalPlan: forward(
        () => import("@/app/(app)/apps/servers/actions"),
        "serverRemovalPlanAction",
        1
    ),
    hostGroups: forward(
        () => import("@/app/(app)/apps/servers/actions"),
        "listHostGroupsAction",
        0
    ),
    followState: forward(
        () => import("@/app/(app)/apps/servers/actions"),
        "serverFollowStateAction",
        1
    ),
    githubKeys: forward(
        () => import("@/app/(app)/apps/servers/ssh-key-actions"),
        "githubKeysAction",
        0
    ),
    leftoverAutoRemove: forward(
        () => import("@/app/(app)/apps/servers/actions"),
        "leftoverAutoRemoveAction",
        0
    ),
    sharedHost: forward(() => import("@/app/(app)/apps/servers/actions"), "sharedHostAction", 1)
}));

vi.mock("@/app/(app)/apps/agents/sessions/sessions-polls", () => ({
    sessionScreen: forward(
        () => import("@/app/(app)/apps/agents/sessions/actions"),
        "sessionScreenAction",
        1
    )
}));

vi.mock("@/app/(app)/apps/network-filter/dns-blocker-polls", () => {
    const actions = () => import("@/app/(app)/apps/network-filter/actions");
    return {
        dnsInsights: forward(actions, "dnsInsightsAction", 2),
        dnsTail: forward(actions, "dnsTailAction", 1),
        dnsStatus: forward(actions, "dnsBlockerStatusAction", 0),
        dnsLists: forward(actions, "dnsListsAction", 0),
        dnsHistory: forward(actions, "dnsHistoryAction", 1),
        dnsDevices: forward(actions, "dnsDevicesAction", 1),
        dnsClients: forward(actions, "dnsClientsAction", 1),
        dnsReputation: forward(actions, "dnsReputationAction", 1)
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

vi.mock("@/app/(app)/chat/call-requests", () => {
    const calls = () => import("@/app/(app)/chat/meeting-actions");
    return {
        startCall: forward(calls, "startCallAction", 1),
        joinCall: forward(calls, "joinCallAction", 1),
        joinMeeting: forward(calls, "joinMeetingAction", 1),
        callTicket: forward(calls, "callTokenAction", 1),
        readCall: forward(calls, "readCallAction", 1),
        ownVoice: forward(calls, "ownVoiceAction", 1),
        licensedFilter: forward(calls, "licensedFilterAction", 1),
        claimCall: forward(calls, "claimCallAction", 2)
    };
});

vi.mock("@/components/shared-polls", () => ({
    presenceNow: forward(
        () => import("@/app/(app)/account/preferences/actions"),
        "presenceNowAction",
        0
    ),
    noticeChannels: forward(
        () => import("@/app/(app)/automations/actions"),
        "noticeChannelsAction",
        0
    ),
    recentSearches: forward(
        () => import("@/app/(app)/search-actions"),
        "listRecentSearchesAction",
        0
    ),
    diskAlerts: forward(() => import("@/app/(app)/disk-alert-actions"), "diskAlertsAction", 0),
    domainSecurity: forward(
        () => import("@/app/(app)/account/domains/security-actions"),
        "readDomainSecurityAction",
        2
    ),
    domainSecurityPlan: forward(
        () => import("@/app/(app)/account/domains/security-actions"),
        "planDomainSecurityAction",
        3
    ),
    securityInventory: forward(
        () => import("@/app/(app)/account/domains/security-actions"),
        "securityInventoryAction",
        0
    ),
    namespaceMessages: forward(
        () => import("@/components/i18n/namespace-actions"),
        "namespaceMessagesAction",
        1
    ),
    subjectBreakdown: forward(
        () => import("@/app/(app)/breakdown-actions"),
        "subjectBreakdownAction",
        1
    ),
    restoreHistory: forward(
        () => import("@/app/(app)/apps/deploy/restore-actions"),
        "listHistoryAction",
        1
    ),
    setupState: forward(() => import("@/app/(app)/setup-actions"), "setupStateAction", 0),
    setupInstalled: forward(() => import("@/app/(app)/setup-actions"), "setupInstalledAction", 0),
    stepUpOptions: forward(
        () => import("@/app/(app)/account/step-up-actions"),
        "stepUpOptionsAction",
        0
    ),
    shouldOfferOverview: forward(
        () => import("@/app/(app)/tour-actions"),
        "shouldOfferOverviewAction",
        0
    ),
    userProfile: forward(
        () => import("@/app/(app)/drive/activity-actions"),
        "getUserProfileAction",
        1
    )
}));

vi.mock("@/app/(app)/chat/chat-reads", () => ({
    chatMembers: forward(() => import("@/app/(app)/chat/actions"), "listMembersAction", 1),
    spaceBans: forward(() => import("@/app/(app)/chat/actions"), "spaceBansAction", 1),
    chatInvites: forward(() => import("@/app/(app)/chat/actions"), "listInvitesAction", 2),
    chatWebhooks: forward(() => import("@/app/(app)/chat/actions"), "listWebhooksAction", 1),
    carriedMessage: forward(() => import("@/app/(app)/chat/actions"), "carriedMessageAction", 1),
    chatRules: forward(() => import("@/app/(app)/chat/actions"), "chatRulesAction", 0),
    callsUnavailable: forward(
        () => import("@/app/(app)/chat/meeting-actions"),
        "callsUnavailableAction",
        0
    ),
    editHistory: forward(() => import("@/app/(app)/chat/actions"), "editHistoryAction", 1),
    conversationsElsewhere: forward(
        () => import("@/app/(app)/chat/actions"),
        "conversationsElsewhereAction",
        0
    ),
    tenorReady: forward(() => import("@/app/(app)/chat/actions"), "tenorReadyAction", 0),
    savedMedia: forward(() => import("@/app/(app)/chat/actions"), "listSavedMediaAction", 0),
    readInvite: forward(() => import("@/app/(app)/chat/actions"), "readInviteAction", 1),
    inviteCandidates: forward(
        () => import("@/app/(app)/chat/actions"),
        "inviteCandidatesAction",
        1
    ),
    messageDelivery: forward(() => import("@/app/(app)/chat/actions"), "messageDeliveryAction", 1),
    linkPreview: forward(() => import("@/app/(app)/chat/actions"), "linkPreviewAction", 1),
    chatProfile: forward(() => import("@/app/(app)/chat/actions"), "profileAction", 2),
    meetingList: forward(() => import("@/app/(app)/chat/meeting-actions"), "listMeetingsAction", 0)
}));

vi.mock("@/app/(app)/admin/admin-polls", () => ({
    callServerSettings: forward(
        () => import("@/app/(app)/admin/chat/actions"),
        "callServerSettingsAction",
        0
    ),
    dnsZones: forward(
        () => import("@/app/(app)/account/domains/dns-actions"),
        "listDnsZonesAction",
        0
    ),
    networkStatus: forward(
        () => import("@/app/(app)/admin/domains/actions"),
        "networkStatusAction",
        0
    ),
    firstDiscordChannel: forward(
        () => import("@/app/(app)/admin/inbox/actions"),
        "firstDiscordChannelAction",
        0
    ),
    channelTargets: forward(
        () => import("@/app/(app)/admin/inbox/actions"),
        "listChannelTargetsAction",
        1
    ),
    inboxAgents: forward(() => import("@/app/(app)/admin/inbox/actions"), "listAgentsAction", 0),
    inboxContacts: forward(
        () => import("@/app/(app)/admin/inbox/actions"),
        "listContactsAction",
        0
    ),
    mailBodyHeld: forward(
        () => import("@/app/(app)/admin/retention/actions"),
        "mailBodyHeldAction",
        0
    ),
    ownVulnerabilities: forward(
        () => import("@/app/(app)/admin/settings/actions"),
        "ownVulnerabilitiesAction",
        0
    )
}));

vi.mock("@/app/(app)/drive/drive-reads", () => ({
    linkedAccounts: forward(() => import("@/app/(app)/drive/actions"), "linkedAccountsAction", 1),
    driveJobs: forward(() => import("@/app/(app)/drive/actions"), "driveJobsAction", 2),
    unasShares: forward(() => import("@/app/(app)/drive/actions"), "discoverUnasSharesAction", 1),
    removalPlan: forward(
        () => import("@/app/(app)/drive/actions"),
        "connectionRemovalPlanAction",
        1
    ),
    myShareGroups: forward(
        () => import("@/app/(app)/drive/sharing-actions"),
        "myShareGroupsAction",
        0
    ),
    itemShares: forward(
        () => import("@/app/(app)/drive/sharing-actions"),
        "listItemSharesAction",
        2
    ),
    transferOrgs: forward(
        () => import("@/app/(app)/drive/transfer-actions"),
        "transferOrgsAction",
        0
    ),
    waitingTransfers: forward(
        () => import("@/app/(app)/drive/transfer-actions"),
        "waitingTransfersAction",
        0
    ),
    sentTransfers: forward(
        () => import("@/app/(app)/drive/transfer-actions"),
        "sentTransfersAction",
        0
    ),
    shareLogs: forward(() => import("@/app/(app)/drive/share-actions"), "getShareLogsAction", 1),
    snippetLogs: forward(
        () => import("@/app/(app)/drive/snippets/snippet-actions"),
        "getSnippetLogsAction",
        1
    )
}));

vi.mock("@/app/(app)/account/account-polls", () => ({
    keyUsage: forward(
        () => import("@/app/(app)/account/api-keys/usage-actions"),
        "keyUsageAction",
        1
    ),
    friendsPage: forward(
        () => import("@/app/(app)/account/privacy/actions"),
        "loadFriendsAction",
        1
    ),
    friendRequests: forward(
        () => import("@/app/(app)/account/privacy/actions"),
        "loadFriendRequestsAction",
        0
    ),
    stepUpRemaining: forward(
        () => import("@/app/(app)/account/step-up-actions"),
        "stepUpRemainingAction",
        1
    ),
    trustedDevice: forward(
        () => import("@/app/(app)/account/sessions/actions"),
        "trustedDeviceAction",
        1
    )
}));

vi.mock("@/app/(app)/tasks/tasks-polls", () => ({
    handoffChoices: forward(
        () => import("@/app/(app)/tasks/actions"),
        "agentHandoffChoicesAction",
        0
    ),
    taskDetail: forward(() => import("@/app/(app)/tasks/actions"), "getTaskDetailAction", 1),
    taskShare: forward(() => import("@/app/(app)/tasks/actions"), "getTaskShareAction", 1),
    createContext: forward(() => import("@/app/(app)/tasks/actions"), "createContextAction", 2),
    trackerTargets: forward(
        () => import("@/app/(app)/tasks/trackers/actions"),
        "trackerTargetsAction",
        0
    )
}));

vi.mock("@/app/(app)/apps/analytics/analytics-polls", () => ({
    analyticsSites: forward(
        () => import("@/app/(app)/apps/analytics/actions"),
        "listAnalyticsSitesAction",
        0
    ),
    analyticsOverview: forward(
        () => import("@/app/(app)/apps/analytics/actions"),
        "getAnalyticsOverviewAction",
        1
    )
}));
