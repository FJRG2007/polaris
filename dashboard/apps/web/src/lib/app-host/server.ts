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

import { provideAppHost } from "@polaris/app-host";
import * as appsCatalog from "@/lib/apps/catalog";
import * as appsInstallDefaults from "@/lib/apps/install-defaults";
import * as appsPortAdvice from "@/lib/apps/port-advice";
import * as appsPortBlock from "@/lib/apps/port-block";
import * as backupsSchemas from "@/lib/backups/schemas";
import * as backupsSourcesTypes from "@/lib/backups/sources/types";
import * as hostAddress from "@/lib/host-address";
import * as metricsShared from "@/lib/metrics-shared";
import * as mime from "@/lib/mime";
import { hostPortForApp } from "@/lib/deploy/host-port";
import { portKey } from "@/lib/apps/port-key";
import { readInstallConfig } from "@/lib/apps/install-config-value";
import type { InstalledSlotHost } from "@/components/app-extensions/installed-client";
import type { LiveGrant } from "@/lib/access/grants";
import type { AppExtension, AppJob, AppSlot } from "@/lib/app-extensions/types";
import type { InstallConfig } from "@/lib/apps/install-config";
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
import type { TargetRow } from "@/lib/deploy/runtime";
import type { SessionUser } from "@/lib/session";

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
    apiSession: once(() => import("@/lib/api-session")),
    appContainerMetrics: once(() => import("@/lib/app-container-metrics")),
    appsInstallAccess: once(() => import("@/lib/apps/install-access")),
    appsInstallConfig: once(() => import("@/lib/apps/install-config")),
    appsInstallPresence: once(() => import("@/lib/apps/install-presence")),
    appsInstallSecret: once(() => import("@/lib/apps/install-secret")),
    appsInstallService: once(() => import("@/lib/apps/install-service")),
    appsPortBlockStore: once(() => import("@/lib/apps/port-block-store")),
    appsPortRegistry: once(() => import("@/lib/apps/port-registry")),
    auditService: once(() => import("@/lib/audit-service")),
    backupsManage: once(() => import("@/lib/backups/manage")),
    chatLive: once(() => import("@/lib/chat/live")),
    containerFilesService: once(() => import("@/lib/container-files-service")),
    cronOwners: once(() => import("@/lib/cron/owners")),
    deployDial: once(() => import("@/lib/deploy/dial")),
    deployReleases: once(() => import("@/lib/deploy/releases")),
    deployRuntime: once(() => import("@/lib/deploy/runtime")),
    deployService: once(() => import("@/lib/deploy-service")),
    domainDns: once(() => import("@/lib/domain-dns")),
    domainService: once(() => import("@/lib/domain-service")),
    domainZones: once(() => import("@/lib/domain-zones")),
    envVarService: once(() => import("@/lib/env-var-service")),
    footageStorage: once(() => import("@/lib/footage-storage")),
    hostService: once(() => import("@/lib/host-service")),
    integrationService: once(() => import("@/lib/integration-service")),
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
    requestContext: once(() => import("@/lib/request-context")),
    serverMetricsService: once(() => import("@/lib/server-metrics-service")),
    session: once(() => import("@/lib/session")),
    sessionDirectory: once(() => import("@/lib/session-directory")),
    settingStore: once(() => import("@/lib/setting-store")),
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
        gamePermissionsFor: later(load.appsInstallAccess, "gamePermissionsFor"),
        installRef: later(load.appsInstallAccess, "installRef"),
        reachableInstallIds: later(load.appsInstallAccess, "reachableInstallIds"),
        requireGameServer: later(load.appsInstallAccess, "requireGameServer"),
        requireGameServerOwner: later(load.appsInstallAccess, "requireGameServerOwner")
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
    chatLive: {
        publishChatChange: later(load.chatLive, "publishChatChange")
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
    metricsShared: {
        resolveRange: metricsShared.resolveRange
    },
    mime: {
        imageTypeOfBytes: mime.imageTypeOfBytes
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
    serverMetricsService: {
        getServerMetrics: later(load.serverMetricsService, "getServerMetrics"),
        peekServerMetrics: later(load.serverMetricsService, "peekServerMetrics")
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
    sessionDirectory: {
        userSessionAddresses: later(load.sessionDirectory, "userSessionAddresses")
    },
    settingStore: {
        getSetting: later(load.settingStore, "getSetting"),
        setSetting: later(load.settingStore, "setSetting")
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
        AppSlot: AppSlot;
        BackupSource: BackupSource;
        DiscoveredTarget: DiscoveredTarget;
        GamePort: GamePort;
        GamePortRow: GamePortRow;
        GamePortsReading: GamePortsReading;
        GameReachAdvice: GameReachAdvice;
        InPlaceCopy: InPlaceCopy;
        InstallAccessEntry: InstallAccessEntry;
        InstallAccessView: InstallAccessView;
        InstallConfig: InstallConfig;
        InstallSeed: InstallSeed;
        InstalledAppSetting: InstalledAppSetting;
        InstalledSlotHost: InstalledSlotHost;
        LiveGrant: LiveGrant;
        SessionUser: SessionUser;
        SourceResource: SourceResource;
        StagedArtifact: StagedArtifact;
        TargetRow: TargetRow;
    }
}

provideAppHost(serverHost);
