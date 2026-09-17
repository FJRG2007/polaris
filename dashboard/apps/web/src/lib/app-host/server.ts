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
 * the app registry, and each route an app answers.
 */

import { provideAppHost } from "@polaris/app-host";
import * as appsCatalog from "@/lib/apps/catalog";
import type { LiveGrant } from "@/lib/access/grants";
import type { AppExtension } from "@/lib/app-extensions/types";
import type { SessionUser } from "@/lib/session";

/** A service that is loaded when it is first called, so it always answers later. */
type Later<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

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
    appsInstallPresence: once(() => import("@/lib/apps/install-presence")),
    appsInstallSecret: once(() => import("@/lib/apps/install-secret")),
    appsInstallService: once(() => import("@/lib/apps/install-service")),
    auditService: once(() => import("@/lib/audit-service")),
    chatLive: once(() => import("@/lib/chat/live")),
    deployDial: once(() => import("@/lib/deploy/dial")),
    deployReleases: once(() => import("@/lib/deploy/releases")),
    deployService: once(() => import("@/lib/deploy-service")),
    domainService: once(() => import("@/lib/domain-service")),
    footageStorage: once(() => import("@/lib/footage-storage")),
    hostService: once(() => import("@/lib/host-service")),
    notificationsDispatch: once(() => import("@/lib/notifications/dispatch")),
    notificationsPreferences: once(() => import("@/lib/notifications/preferences")),
    session: once(() => import("@/lib/session")),
    settingStore: once(() => import("@/lib/setting-store")),
    storageTarget: once(() => import("@/lib/storage-target")),
};

export const serverHost = {
    accessGrants: {
        dropGrantsFor: later(load.accessGrants, "dropGrantsFor"),
        grantedSubjects: later(load.accessGrants, "grantedSubjects"),
        liveGrants: later(load.accessGrants, "liveGrants"),
        reachesAnySubject: later(load.accessGrants, "reachesAnySubject"),
        spendGrant: later(load.accessGrants, "spendGrant"),
    },
    apiSession: {
        apiUser: later(load.apiSession, "apiUser"),
    },
    appsCatalog: {
        POLARIS_APP_CATALOG: appsCatalog.POLARIS_APP_CATALOG,
        findApp: appsCatalog.findApp,
    },
    appsInstallPresence: {
        isAppInstalled: later(load.appsInstallPresence, "isAppInstalled"),
    },
    appsInstallSecret: {
        installEnvSecret: later(load.appsInstallSecret, "installEnvSecret"),
        installEnvValue: later(load.appsInstallSecret, "installEnvValue"),
    },
    appsInstallService: {
        installApp: later(load.appsInstallService, "installApp"),
    },
    auditService: {
        recordAudit: later(load.auditService, "recordAudit"),
    },
    chatLive: {
        publishChatChange: later(load.chatLive, "publishChatChange"),
    },
    deployDial: {
        localDialHost: later(load.deployDial, "localDialHost"),
    },
    deployReleases: {
        serviceRef: later(load.deployReleases, "serviceRef"),
    },
    deployService: {
        deployApplication: later(load.deployService, "deployApplication"),
        hostPortForApp: later(load.deployService, "hostPortForApp"),
        setApplicationRunning: later(load.deployService, "setApplicationRunning"),
    },
    domainService: {
        appBaseUrl: later(load.domainService, "appBaseUrl"),
    },
    footageStorage: {
        footageTarget: later(load.footageStorage, "footageTarget"),
    },
    hostService: {
        getHostConnection: later(load.hostService, "getHostConnection"),
        listHosts: later(load.hostService, "listHosts"),
    },
    notificationsDispatch: {
        notify: later(load.notificationsDispatch, "notify"),
    },
    notificationsPreferences: {
        ruleFor: later(load.notificationsPreferences, "ruleFor"),
    },
    session: {
        homePathForUser: later(load.session, "homePathForUser"),
        requirePermission: later(load.session, "requirePermission"),
        requireUser: later(load.session, "requireUser"),
        sessionCan: later(load.session, "sessionCan"),
        sessionCanAny: later(load.session, "sessionCanAny"),
    },
    settingStore: {
        getSetting: later(load.settingStore, "getSetting"),
        setSetting: later(load.settingStore, "setSetting"),
    },
    storageTarget: {
        driverForTarget: later(load.storageTarget, "driverForTarget"),
        placeFile: later(load.storageTarget, "placeFile"),
        safeName: later(load.storageTarget, "safeName"),
        storageTargetOptions: later(load.storageTarget, "storageTargetOptions"),
    }
};

type ServerHost = typeof serverHost;

declare module "@polaris/app-host" {
    interface AppHost extends ServerHost {}
    interface AppHostTypes {
        AppExtension: AppExtension;
        LiveGrant: LiveGrant;
        SessionUser: SessionUser;
    }
}

provideAppHost(serverHost);
