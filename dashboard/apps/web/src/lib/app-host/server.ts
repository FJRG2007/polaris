/**
 * What the dashboard offers installable apps on the server: the contract.
 *
 * An app never imports the dashboard's modules (see @polaris/app-host and
 * docs/installable-apps-plan.md); it takes these instead. Each area is one
 * dashboard module and names only what apps actually use, so this file is the
 * whole of what an app can reach - adding to it widens what every app may do,
 * and taking something away breaks the apps that used it at compile time.
 *
 * Loaded on first use rather than imported here: this module is imported
 * wherever an app's code may run, and the services behind it reach the
 * database, the session and the container runtime. A test that replaces one
 * of those modules therefore replaces it for the apps too.
 *
 * Imported for its effect by everything that can run an app's server code:
 * server start (`instrumentation.ts`), the app registry, and each route an app
 * answers.
 */

import * as mime from "@/lib/mime";
import { McpRefusal, defineMcpTool } from "@/lib/mcp/protocol";
import { StepError, StepRefusal } from "@/lib/automations/types";
import { defineMcpSearch } from "@/lib/mcp/search";
import { portKey } from "@/lib/apps/port-key";
import * as appsCatalog from "@/lib/apps/catalog";
import * as hostAddress from "@/lib/host-address";
import { provideAppHost } from "@polaris/app-host";
import type { LiveGrant } from "@/lib/access/grants";
import * as metricsShared from "@/lib/metrics-shared";
import * as appsPortBlock from "@/lib/apps/port-block";
import * as backupsSchemas from "@/lib/backups/schemas";
import { hostPortForApp } from "@/lib/deploy/host-port";
import * as appsPortAdvice from "@/lib/apps/port-advice";
import * as appsInstallDefaults from "@/lib/apps/install-defaults";
import * as backupsSourcesTypes from "@/lib/backups/sources/types";
import { readInstallConfig } from "@/lib/apps/install-config-value";
import type { InstalledSlotHost } from "@/components/app-extensions/installed-client";
import type {
    AppExtension,
    AppJob,
    AppWidgetDefinition,
    AppWidgetView,
    AppSlot,
    ChatGameLink,
    RelayedChannelMessage
} from "@/lib/app-extensions/types";
import type { InstallConfig } from "@/lib/apps/install-config";
import type { McpScope } from "@/lib/mcp/scope-table";
import type { McpCaller, McpTool, McpToolResult } from "@/lib/mcp/protocol";
import type { McpSearchHit, McpSearchProvider } from "@/lib/mcp/search";
import type { LinkableConversations } from "@/lib/chat/game-links";
import type { InstallSeed, InstalledAppSetting } from "@/lib/apps/install-service";
import type { InstallAccessEntry, InstallAccessView } from "@/lib/apps/install-sharing";
import type {
    GamePort,
    GamePortRow,
    GamePortsReading,
    GameReachAdvice
} from "@/lib/apps/port-advice";
import type {
    BackupSource,
    DiscoveredTarget,
    InPlaceCopy,
    SourceResource,
    StagedArtifact
} from "@/lib/backups/sources/types";
import type { SessionUser } from "@/lib/session";
import type { TargetRow } from "@/lib/deploy/runtime";
import type { InstallCopyProgress, InstallCopySource } from "@/lib/apps/install-duplicate";
import type {
    CalendarLink,
    CalendarPerson,
    CalendarTask,
    CalendarTeam,
    SealedSecret
} from "@/lib/calendar-host";
import type { CrmShelf, CrmShelfPerson } from "@/lib/crm-host";
import type { CloudEnrollment } from "@/lib/cloud-servers-host";
import type { AppStorageView } from "@/lib/storage-moves/app-storage";
import type { StorageChoice } from "@/lib/storage-moves/placement";

/** A service that is loaded when it is first called, so it always answers later. */
type Later<F> = F extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;

function later<M, K extends keyof M>(load: () => Promise<M>, name: K): Later<M[K]> {
    return (async (...args: unknown[]) => {
        const service = (await load())[name] as unknown as (...a: unknown[]) => unknown;
        return service(...args);
    }) as Later<M[K]>;
}

/** One load per area, shared by every call that arrives while it is on its way. */
function once<M>(load: () => Promise<M>): () => Promise<M> {
    let loading: Promise<M> | undefined;
    return () => (loading ??= load());
}

const load = {
    accessGrants: once(() => import("@/lib/access/grants")),
    activityLive: once(() => import("@/lib/presence-activity/live")),
    apiSession: once(() => import("@/lib/api-session")),
    automations: once(() => import("@/lib/automations/app-bridge")),
    appContainerMetrics: once(() => import("@/lib/app-container-metrics")),
    appsInstallAccess: once(() => import("@/lib/apps/install-access")),
    appsInstallConfig: once(() => import("@/lib/apps/install-config")),
    appsInstallDuplicate: once(() => import("@/lib/apps/install-duplicate")),
    appsInstallPresence: once(() => import("@/lib/apps/install-presence")),
    appsInstallSecret: once(() => import("@/lib/apps/install-secret")),
    appsInstallService: once(() => import("@/lib/apps/install-service")),
    appsInstallSharing: once(() => import("@/lib/apps/install-sharing")),
    appsPortBlockStore: once(() => import("@/lib/apps/port-block-store")),
    appsPortRegistry: once(() => import("@/lib/apps/port-registry")),
    appStorage: once(() => import("@/lib/storage-moves/app-storage")),
    auditService: once(() => import("@/lib/audit-service")),
    backupsManage: once(() => import("@/lib/backups/manage")),
    calendarHost: once(() => import("@/lib/calendar-host")),
    crmHost: once(() => import("@/lib/crm-host")),
    cloudServersHost: once(() => import("@/lib/cloud-servers-host")),
    chatGameLinks: once(() => import("@/lib/chat/game-links")),
    chatLive: once(() => import("@/lib/chat/live")),
    chatMeetingEvents: once(() => import("@/lib/chat/meeting-events")),
    chatMeetings: once(() => import("@/lib/chat/meetings")),
    containerFilesService: once(() => import("@/lib/container-files-service")),
    cronOwners: once(() => import("@/lib/cron/owners")),
    deployDial: once(() => import("@/lib/deploy/dial")),
    deployReleases: once(() => import("@/lib/deploy/releases")),
    deployRuntime: once(() => import("@/lib/deploy/runtime")),
    deployService: once(() => import("@/lib/deploy-service")),
    domainDns: once(() => import("@/lib/domain-dns")),
    appEdge: once(() => import("@/lib/app-edge")),
    domainService: once(() => import("@/lib/domain-service")),
    domainZones: once(() => import("@/lib/domain-zones")),
    envVarService: once(() => import("@/lib/env-var-service")),
    footageStorage: once(() => import("@/lib/footage-storage")),
    hostService: once(() => import("@/lib/host-service")),
    neighbours: once(() => import("@/lib/storage-whereabouts/neighbours")),
    i18nLocaleService: once(() => import("@/lib/i18n/locale-service")),
    i18nRequest: once(() => import("@/lib/i18n/request")),
    mcpActingUser: once(() => import("@/lib/mcp/acting-user")),
    integrationService: once(() => import("@/lib/integration-service")),
    minecraftRouter: once(() => import("@/lib/minecraft-router")),
    integrationsCloudflareAccountService: once(
        () => import("@/lib/integrations/cloudflare-account-service")
    ),
    integrationsCloudflareApi: once(() => import("@/lib/integrations/cloudflare-api")),
    netPortProbe: once(() => import("@/lib/net/port-probe")),
    networkService: once(() => import("@/lib/network-service")),
    notificationService: once(() => import("@/lib/notification-service")),
    notificationsDispatch: once(() => import("@/lib/notifications/dispatch")),
    notificationsPreferences: once(() => import("@/lib/notifications/preferences")),
    rateLimitService: once(() => import("@/lib/rate-limit-service")),
    registry: once(() => import("@/lib/registry")),
    requestContext: once(() => import("@/lib/request-context")),
    safeFetch: once(() => import("@/lib/safe-fetch")),
    seasonalService: once(() => import("@/lib/seasonal-service")),
    serverMetricsService: once(() => import("@/lib/server-metrics-service")),
    session: once(() => import("@/lib/session")),
    sessionDirectory: once(() => import("@/lib/session-directory")),
    settingStore: once(() => import("@/lib/setting-store")),
    storageHold: once(() => import("@/lib/storage-moves/hold")),
    storageTarget: once(() => import("@/lib/storage-target")),
    wafService: once(() => import("@/lib/waf-service"))
};

export const serverHost = {
    accessGrants: {
        dropGrantsFor: later(load.accessGrants, "dropGrantsFor"),
        grantedSubjects: later(load.accessGrants, "grantedSubjects"),
        liveGrants: later(load.accessGrants, "liveGrants"),
        reachesAnySubject: later(load.accessGrants, "reachesAnySubject"),
        spendGrant: later(load.accessGrants, "spendGrant")
    },
    // Somebody's presence card changed because of something an app saw - a
    // player arriving on a server - so the screens drawing them ask again.
    activityLive: {
        announceActivity: later(load.activityLive, "announceActivity")
    },
    apiSession: {
        apiUser: later(load.apiSession, "apiUser")
    },
    appContainerMetrics: {
        readAppContainerMetricsOrNull: later(
            load.appContainerMetrics,
            "readAppContainerMetricsOrNull"
        ),
        readAppContainerRuntime: later(load.appContainerMetrics, "readAppContainerRuntime")
    },
    appsCatalog: {
        catalogApps: appsCatalog.catalogApps,
        envFormatHint: appsCatalog.envFormatHint,
        findApp: appsCatalog.findApp,
        isAllowedEnvValue: appsCatalog.isAllowedEnvValue,
        isGameServerApp: appsCatalog.isGameServerApp,
        normalizeEnvValue: appsCatalog.normalizeEnvValue,
        promptedEnvVars: appsCatalog.promptedEnvVars,
        tunableEnvVars: appsCatalog.tunableEnvVars
    },
    appsInstallAccess: {
        // The same standing `requireGameServer` reads, for a caller with no
        // session - an MCP tool, acting for the user `mcp.actingUser` built.
        gameServerAccess: later(load.appsInstallAccess, "gameServerAccess"),
        gamePermissionsFor: later(load.appsInstallAccess, "gamePermissionsFor"),
        installRef: later(load.appsInstallAccess, "installRef"),
        reachableInstallIds: later(load.appsInstallAccess, "reachableInstallIds"),
        requireGameServer: later(load.appsInstallAccess, "requireGameServer"),
        requireGameServerOwner: later(load.appsInstallAccess, "requireGameServerOwner")
    },
    appsInstallSharing: {
        invitePlayer: later(load.appsInstallSharing, "invitePlayer")
    },
    appsInstallConfig: {
        patchInstallConfig: later(load.appsInstallConfig, "patchInstallConfig"),
        readInstallConfig
    },
    appsInstallDefaults: {
        defaultInstallInput: appsInstallDefaults.defaultInstallInput
    },
    appsInstallPresence: {
        isAppInstalled: later(load.appsInstallPresence, "isAppInstalled")
    },
    appsInstallSecret: {
        installEnvSecret: later(load.appsInstallSecret, "installEnvSecret"),
        installEnvValue: later(load.appsInstallSecret, "installEnvValue"),
        readInstallEnvSecret: later(load.appsInstallSecret, "readInstallEnvSecret")
    },
    appsInstallDuplicate: {
        copyInstallData: later(load.appsInstallDuplicate, "copyInstallData"),
        createInstallCopy: later(load.appsInstallDuplicate, "createInstallCopy"),
        discardInstallCopy: later(load.appsInstallDuplicate, "discardInstallCopy"),
        measureInstallData: later(load.appsInstallDuplicate, "measureInstallData"),
        readInstallCopySource: later(load.appsInstallDuplicate, "readInstallCopySource"),
        verifyInstallCopy: later(load.appsInstallDuplicate, "verifyInstallCopy")
    },
    appsInstallService: {
        installApp: later(load.appsInstallService, "installApp"),
        listInstalledApps: later(load.appsInstallService, "listInstalledApps"),
        uninstallApp: later(load.appsInstallService, "uninstallApp")
    },
    appsPortAdvice: {
        describeBlocksFor: appsPortAdvice.describeBlocksFor,
        describePorts: appsPortAdvice.describePorts,
        gameReachAdvice: appsPortAdvice.gameReachAdvice,
        gameStoppedAdvice: appsPortAdvice.gameStoppedAdvice
    },
    appsPortBlock: {
        describeBlock: appsPortBlock.describeBlock,
        inBlock: appsPortBlock.inBlock
    },
    appsPortBlockStore: {
        getPortBlocks: later(load.appsPortBlockStore, "getPortBlocks"),
        getPortPolicy: later(load.appsPortBlockStore, "getPortPolicy")
    },
    appsPortRegistry: {
        availableHostPort: later(load.appsPortRegistry, "availableHostPort"),
        availableHostPortRun: later(load.appsPortRegistry, "availableHostPortRun"),
        portKey,
        takenHostPorts: later(load.appsPortRegistry, "takenHostPorts")
    },
    appStorage: {
        appStorageView: later(load.appStorage, "appStorageView"),
        chooseAppStorage: later(load.appStorage, "chooseAppStorage")
    },
    auditService: {
        recordAudit: later(load.auditService, "recordAudit")
    },
    backupsManage: {
        applyWorldSchedule: later(load.backupsManage, "applyWorldSchedule")
    },
    backupsSchemas: {
        buildSelector: backupsSchemas.buildSelector
    },
    backupsSourcesTypes: {
        SourceUnavailableError: backupsSourcesTypes.SourceUnavailableError,
        shellQuote: backupsSourcesTypes.shellQuote,
        stageDir: backupsSourcesTypes.stageDir,
        stagedFrom: backupsSourcesTypes.stagedFrom
    },
    // What the Calendar app reaches beyond the other apps: the accounts people
    // link for it, a sealed server password, a fetch safe to point at an address
    // somebody configured, the people and teams it shares with and invites, the
    // Tasks work it draws, and mail that carries an invitation.
    calendarHost: {
        accountsByEmail: later(load.calendarHost, "accountsByEmail"),
        assignedTasks: later(load.calendarHost, "assignedTasks"),
        setTaskDone: later(load.calendarHost, "setTaskDone"),
        calendarAccessToken: later(load.calendarHost, "calendarAccessToken"),
        calendarFetch: later(load.calendarHost, "calendarFetch"),
        calendarLinkAvailable: later(load.calendarHost, "calendarLinkAvailable"),
        calendarLinkUrl: later(load.calendarHost, "calendarLinkUrl"),
        createDueTask: later(load.calendarHost, "createDueTask"),
        createMeetingLink: later(load.calendarHost, "createMeetingLink"),
        displayTimeZone: later(load.calendarHost, "displayTimeZone"),
        googleClientProject: later(load.calendarHost, "googleClientProject"),
        listCalendarLinks: later(load.calendarHost, "listCalendarLinks"),
        openCalendarSecret: later(load.calendarHost, "openCalendarSecret"),
        peopleByIds: later(load.calendarHost, "peopleByIds"),
        peopleInReach: later(load.calendarHost, "peopleInReach"),
        scheduleTask: later(load.calendarHost, "scheduleTask"),
        sealCalendarSecret: later(load.calendarHost, "sealCalendarSecret"),
        searchPeople: later(load.calendarHost, "searchPeople"),
        sendCalendarEmail: later(load.calendarHost, "sendCalendarEmail"),
        taskListsFor: later(load.calendarHost, "taskListsFor"),
        teamIdsOf: later(load.calendarHost, "teamIdsOf"),
        teamMemberIds: later(load.calendarHost, "teamMemberIds"),
        teamsOf: later(load.calendarHost, "teamsOf")
    },
    // What Cloud servers reaches: its credentials sealed with the master key,
    // and the same enrollment a server added by hand goes through.
    cloudServersHost: {
        cloudEnrollmentStatus: later(load.cloudServersHost, "cloudEnrollmentStatus"),
        openCloudEnrollment: later(load.cloudServersHost, "openCloudEnrollment"),
        openCloudSecret: later(load.cloudServersHost, "openCloudSecret"),
        removeCloudHost: later(load.cloudServersHost, "removeCloudHost"),
        sealCloudSecret: later(load.cloudServersHost, "sealCloudSecret")
    },
    // What the CRM reaches beyond the other apps: the shelf the reader works
    // from, what their organization's role lets them do there, and who on it
    // may own a record.
    crmHost: {
        crmCanSendMail: later(load.crmHost, "crmCanSendMail"),
        crmCreateNote: later(load.crmHost, "crmCreateNote"),
        crmDriveFileRef: later(load.crmHost, "crmDriveFileRef"),
        crmDriveFiles: later(load.crmHost, "crmDriveFiles"),
        crmEventsWith: later(load.crmHost, "crmEventsWith"),
        crmMailWith: later(load.crmHost, "crmMailWith"),
        crmSendMail: later(load.crmHost, "crmSendMail"),
        crmChatChannels: later(load.crmHost, "crmChatChannels"),
        crmSendChat: later(load.crmHost, "crmSendChat"),
        crmNoteShelves: later(load.crmHost, "crmNoteShelves"),
        crmNotesByIds: later(load.crmHost, "crmNotesByIds"),
        crmOrgPeople: later(load.crmHost, "crmOrgPeople"),
        crmOrgAccess: later(load.crmHost, "crmOrgAccess"),
        crmOrgPermissions: later(load.crmHost, "crmOrgPermissions"),
        crmOrgRoles: later(load.crmHost, "crmOrgRoles"),
        crmPostJson: later(load.crmHost, "crmPostJson"),
        crmReach: later(load.crmHost, "crmReach"),
        crmRunner: later(load.crmHost, "crmRunner"),
        crmShelf: later(load.crmHost, "crmShelf"),
        createTask: later(load.calendarHost, "createDueTask"),
        peopleByIds: later(load.calendarHost, "peopleByIds"),
        setTaskDone: later(load.calendarHost, "setTaskDone"),
        taskListsFor: later(load.calendarHost, "taskListsFor"),
        tasksByIds: later(load.calendarHost, "tasksByIds")
    },
    // What a game server may be linked to in Chat, and the line it writes into
    // the linked channel when an announcement is repeated there.
    chatLinks: {
        linkableConversations: later(load.chatGameLinks, "linkableConversations"),
        postAppNotice: later(load.chatGameLinks, "postAppNotice")
    },
    chatLive: {
        publishChatChange: later(load.chatLive, "publishChatChange")
    },
    // Who is in a chat group's call, by the rule the chat itself draws it with,
    // and a word when somebody joins or leaves one - what a game server's side
    // panel needs to keep "in call: 2/5" true as it happens.
    chatCalls: {
        subscribeMeetingEvents: later(load.chatMeetingEvents, "subscribeMeetingEvents"),
        voicePresence: later(load.chatMeetings, "voicePresence")
    },
    containerFilesService: {
        readContainerFile: later(load.containerFilesService, "readContainerFile"),
        writeContainerFile: later(load.containerFilesService, "writeContainerFile")
    },
    cronOwners: {
        ownersWithApps: later(load.cronOwners, "ownersWithApps")
    },
    deployDial: {
        localDialHost: later(load.deployDial, "localDialHost")
    },
    deployReleases: {
        currentReleaseRef: later(load.deployReleases, "currentReleaseRef"),
        serviceRef: later(load.deployReleases, "serviceRef")
    },
    deployRuntime: {
        getPorts: later(load.deployRuntime, "getPorts")
    },
    deployService: {
        deployApplication: later(load.deployService, "deployApplication"),
        hostPortForApp,
        readAppRuntimeLog: later(load.deployService, "readAppRuntimeLog"),
        setApplicationRunning: later(load.deployService, "setApplicationRunning")
    },
    domainDns: {
        provisionHostnameDns: later(load.domainDns, "provisionHostnameDns")
    },
    // The one edge file an app may write, its own, routing hostnames it owns to
    // the dashboard. Emptied by core when the app is uninstalled.
    appEdge: {
        appEdgeOrigin: later(load.appEdge, "appEdgeOrigin"),
        edgeHostnameTaken: later(load.appEdge, "edgeHostnameTaken"),
        writeAppEdge: later(load.appEdge, "writeAppEdge")
    },
    domainService: {
        appBaseUrl: later(load.domainService, "appBaseUrl"),
        getPublicIp: later(load.domainService, "getPublicIp"),
        publicAppUrl: later(load.domainService, "publicAppUrl"),
        requestOrigin: later(load.domainService, "requestOrigin")
    },
    domainZones: {
        getDomainZones: later(load.domainZones, "getDomainZones")
    },
    envVarService: {
        listEnvVars: later(load.envVarService, "listEnvVars"),
        revealEnvVar: later(load.envVarService, "revealEnvVar"),
        setEnvVars: later(load.envVarService, "setEnvVars")
    },
    footageStorage: {
        footageTarget: later(load.footageStorage, "footageTarget")
    },
    hostAddress: {
        getHostLanIp: hostAddress.getHostLanIp,
        isLanAddress: hostAddress.isLanAddress
    },
    hostService: {
        getHostConnection: later(load.hostService, "getHostConnection"),
        listHosts: later(load.hostService, "listHosts")
    },
    // The host's neighbour table (IP -> hardware address), for an app that is
    // given a device by its MAC and has to find the address it was lent. Empty
    // where it cannot be read (no host daemon, no host-network container).
    hostNetwork: {
        readNeighbourTable: later(load.neighbours, "readNeighbourTable")
    },
    // Which language to write in. An app ships its own catalogs and formats
    // them with `defineCatalogs` from @polaris/core; what it needs from here is
    // who is reading - the request's reader, or any account by id (a linked
    // player, the recipient of a notification). See docs/i18n.md.
    i18nLocaleService: {
        getUserLocale: later(load.i18nLocaleService, "getUserLocale"),
        storedLocale: later(load.i18nLocaleService, "storedLocale")
    },
    i18nRequest: {
        getLocale: later(load.i18nRequest, "getLocale")
    },
    integrationService: {
        getIntegrationSecret: later(load.integrationService, "getIntegrationSecret")
    },
    integrationsCloudflareAccountService: {
        loadCloudflareToken: later(load.integrationsCloudflareAccountService, "loadCloudflareToken")
    },
    integrationsCloudflareApi: {
        deleteDnsRecord: later(load.integrationsCloudflareApi, "deleteDnsRecord"),
        findDnsRecords: later(load.integrationsCloudflareApi, "findDnsRecords"),
        resolveZoneForHostname: later(load.integrationsCloudflareApi, "resolveZoneForHostname"),
        upsertSrvRecord: later(load.integrationsCloudflareApi, "upsertSrvRecord")
    },
    // What an app needs to offer tools over MCP (the `mcpTools` hook): a
    // tool typed against its own schema, the refusal a model is shown as
    // written, and the person a call acts for, shaped like a session so the
    // app's own access rules decide. And `defineSearch`, for the providers
    // its `mcpSearch` hook offers `polaris_search` (lib/mcp/search.ts).
    // See docs/installable-apps-plan.md.
    mcp: {
        McpRefusal,
        actingUser: later(load.mcpActingUser, "actingUser"),
        defineTool: defineMcpTool,
        defineSearch: defineMcpSearch
    },
    metricsShared: {
        resolveRange: metricsShared.resolveRange
    },
    mime: {
        imageTypeOfBytes: mime.imageTypeOfBytes
    },
    minecraftRouter: {
        startRouter: later(load.minecraftRouter, "startRouter"),
        stopRouter: later(load.minecraftRouter, "stopRouter")
    },
    netPortProbe: {
        probeTcpPort: later(load.netPortProbe, "probeTcpPort"),
        publicProbeHost: later(load.netPortProbe, "publicProbeHost")
    },
    networkService: {
        getLocalEnvironment: later(load.networkService, "getLocalEnvironment"),
        networkPublicIp: later(load.networkService, "networkPublicIp")
    },
    notificationService: {
        createNotification: later(load.notificationService, "createNotification")
    },
    notificationsDispatch: {
        notify: later(load.notificationsDispatch, "notify")
    },
    notificationsPreferences: {
        ruleFor: later(load.notificationsPreferences, "ruleFor")
    },
    rateLimitService: {
        rateLimit: later(load.rateLimitService, "rateLimit"),
        resetRateLimit: later(load.rateLimitService, "resetRateLimit")
    },
    requestContext: {
        clientIp: later(load.requestContext, "clientIp")
    },
    // An address a person typed, fetched with every hop checked for a private
    // address, a timeout and a byte ceiling.
    safeFetch: {
        follow: later(load.safeFetch, "follow"),
        readCapped: later(load.safeFetch, "readCapped"),
        safeUrl: later(load.safeFetch, "safeUrl")
    },
    seasonalService: {
        seasonsAllowed: later(load.seasonalService, "seasonsAllowed")
    },
    serverMetricsService: {
        getServerMetrics: later(load.serverMetricsService, "getServerMetrics"),
        peekServerMetrics: later(load.serverMetricsService, "peekServerMetrics")
    },
    // An app's own triggers firing runs, a move of its automations, its waits woken.
    automations: {
        appTriggers: later(load.automations, "appTriggers"),
        automationForLegacy: later(load.automations, "automationForLegacy"),
        automationsForLegacy: later(load.automations, "automationsForLegacy"),
        fireAppTrigger: later(load.automations, "fireAppTrigger"),
        importLegacyAutomation: later(load.automations, "importLegacyAutomation"),
        StepError,
        StepRefusal,
        wakeAppWaits: later(load.automations, "wakeAppWaits")
    },
    session: {
        homePathForUser: later(load.session, "homePathForUser"),
        requirePermission: later(load.session, "requirePermission"),
        requirePermissionAny: later(load.session, "requirePermissionAny"),
        requireUser: later(load.session, "requireUser"),
        sessionCan: later(load.session, "sessionCan"),
        sessionCanAny: later(load.session, "sessionCanAny"),
        userHasManage: later(load.session, "userHasManage")
    },
    registry: {
        readTagDigest: later(load.registry, "readTagDigest")
    },
    sessionDirectory: {
        userSessionAddresses: later(load.sessionDirectory, "userSessionAddresses")
    },
    settingStore: {
        getSetting: later(load.settingStore, "getSetting"),
        setSetting: later(load.settingStore, "setSetting")
    },
    // A job that stopped a server to work on its files, so no storage move takes
    // them away meanwhile.
    storageHold: {
        holdStorage: later(load.storageHold, "holdStorage"),
        releaseStorage: later(load.storageHold, "releaseStorage")
    },
    storageTarget: {
        driverForTarget: later(load.storageTarget, "driverForTarget"),
        placeFile: later(load.storageTarget, "placeFile"),
        safeName: later(load.storageTarget, "safeName"),
        storageTargetOptions: later(load.storageTarget, "storageTargetOptions")
    },
    wafService: {
        resolveWaf: later(load.wafService, "resolveWaf")
    }
};

type ServerHost = typeof serverHost;

declare module "@polaris/app-host" {
    interface AppHost extends ServerHost {}
    interface AppHostTypes {
        AppExtension: AppExtension;
        AppJob: AppJob;
        AppWidgetDefinition: AppWidgetDefinition;
        AppWidgetView: AppWidgetView;
        AppSlot: AppSlot;
        AppStorageView: AppStorageView;
        BackupSource: BackupSource;
        CalendarLink: CalendarLink;
        CalendarPerson: CalendarPerson;
        CalendarTask: CalendarTask;
        CalendarTeam: CalendarTeam;
        ChatGameLink: ChatGameLink;
        CloudEnrollment: CloudEnrollment;
        CrmShelf: CrmShelf;
        CrmShelfPerson: CrmShelfPerson;
        DiscoveredTarget: DiscoveredTarget;
        GamePort: GamePort;
        GamePortRow: GamePortRow;
        GamePortsReading: GamePortsReading;
        GameReachAdvice: GameReachAdvice;
        InPlaceCopy: InPlaceCopy;
        InstallAccessEntry: InstallAccessEntry;
        InstallAccessView: InstallAccessView;
        InstallConfig: InstallConfig;
        InstallCopyProgress: InstallCopyProgress;
        InstallCopySource: InstallCopySource;
        InstallSeed: InstallSeed;
        InstalledAppSetting: InstalledAppSetting;
        InstalledSlotHost: InstalledSlotHost;
        LinkableConversations: LinkableConversations;
        LiveGrant: LiveGrant;
        McpCaller: McpCaller;
        McpScope: McpScope;
        McpTool: McpTool<never>;
        McpToolResult: McpToolResult;
        McpSearchHit: McpSearchHit;
        McpSearchProvider: McpSearchProvider;
        RelayedChannelMessage: RelayedChannelMessage;
        SealedSecret: SealedSecret;
        SessionUser: SessionUser;
        SourceResource: SourceResource;
        StagedArtifact: StagedArtifact;
        StorageChoice: StorageChoice;
        TargetRow: TargetRow;
    }
}

provideAppHost(serverHost);
