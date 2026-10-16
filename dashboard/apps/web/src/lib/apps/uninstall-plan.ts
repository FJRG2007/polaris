/**
 * What installing an app leaves on a Polaris, and what uninstalling it does with
 * each piece.
 *
 * Pure, so the promise the detail page makes - "uninstalling leaves nothing
 * behind" - is something a test can hold the code to: every resource the install
 * path creates has an entry in the plan, and each entry either removes it or says
 * why it is kept. `install-service` and `deploy-service` carry the plan out; this
 * file is the inventory they are checked against.
 */

import type { AppManifest } from "@/lib/apps/catalog";

/** One kind of thing an install creates. */
export type InstallResource =
    /** The InstalledApp row itself. */
    | "install-row"
    /** The hub's shared secret, stored encrypted on the install row. */
    | "install-secret"
    /** Access people were given to this install (ResourceGrant rows). */
    | "grants"
    /** The switcher's cached "is this app installed" answer and every open switcher. */
    | "presence"
    /** A builtin app's own code bundle. */
    | "app-bundle"
    /** The helper apps a builtin app runs (`ownedBy`), e.g. the camera relay. */
    | "owned-services"
    /** Rows other features keep under the install id (game stats, places, cameras...). */
    | "install-data"
    /** Files a builtin app writes for an install outside the database (camera
     *  recordings and event stills), on the local disk or a storage connection. */
    | "install-files"
    /** The Deploy Application row backing a container app. */
    | "application"
    /** Its deployment history rows. */
    | "deployments"
    /** Its containers, one compose (or swarm stack) project per kept release. */
    | "containers"
    /** The project's own compose network. */
    | "network"
    /** Its environment variables, generated credentials included. */
    | "env-vars"
    /** Its Volume rows. */
    | "volume-rows"
    /** What is inside its volumes, and the Docker volumes themselves. */
    | "volume-data"
    /** Domain rows pointing at it. */
    | "domains"
    /** Its routers in Traefik's dynamic configuration. */
    | "edge-routes"
    /** A quick tunnel publishing it. */
    | "quick-tunnel"
    /** Firewall rules scoped to its service. */
    | "firewall-rules"
    /** Analytics collected for its service. */
    | "analytics"
    /** Scheduled jobs and runtime log lines on its service. */
    | "service-children"
    /** The messaging bridge's cached endpoint. */
    | "bridge-cache"
    /** The owner's shared Marketplace project and its environment. */
    | "marketplace-project"
    /** The server it runs on, as a deploy target. */
    | "deploy-target"
    /** The audit entry for the install. */
    | "audit";

export type UninstallStep =
    | { readonly action: "remove"; readonly how: string }
    | { readonly action: "keep"; readonly why: string };

export interface UninstallOptions {
    /** The reader confirmed that the app's data is deleted with it. */
    readonly deleteData: boolean;
}

/**
 * Every model that keeps rows under an install id, deleted children first so a
 * relation without a cascade never refuses the purge. `uninstall-plan.test`
 * reads the Prisma schema and fails when a model with an `installedAppId` is
 * missing here.
 */
export const INSTALL_SCOPED_MODELS = [
    "alertRule",
    "placeAutomation",
    "placeDeviceAccount",
    "placeDevice",
    "placeRoom",
    "placeFloor",
    "camera",
    "homePerson",
    "place",
    "gamePlayerAccess",
    "gamePlayerLink",
    "gameSanction",
    "playerInventorySnapshot",
    "eventInventoryStash",
    "gameRuleSetting",
    "gamePlayerStat",
    "playerActionQueue",
    "gamePlayerSession",
    "gameSample",
    "gameServerPref",
    "minecraftLoginCheckIn",
    "minecraftLogin",
    "minecraftAnticheatFlag",
    "minecraftSound",
    "minecraftSoundPack",
    "minecraftChatBlock",
    "minecraftChallengePlayer"
] as const;

export type InstallScopedModel = (typeof INSTALL_SCOPED_MODELS)[number];

/** Everything installing this app creates, read off its manifest the way `installApp` does. */
export function installFootprint(app: AppManifest): InstallResource[] {
    const shared: InstallResource[] = [
        "install-row",
        "grants",
        "presence",
        "install-data",
        "audit"
    ];
    if (app.installMethod === "builtin") {
        return [...shared, "install-files", "app-bundle", "owned-services"];
    }
    const resources: InstallResource[] = [
        ...shared,
        "application",
        "deployments",
        "containers",
        "network",
        "env-vars",
        "domains",
        "edge-routes",
        "quick-tunnel",
        "firewall-rules",
        "analytics",
        "service-children",
        "marketplace-project",
        "deploy-target"
    ];
    if ((app.template?.volumes?.length ?? 0) > 0) resources.push("volume-rows", "volume-data");
    if (app.capabilities.includes("messaging-hub")) resources.push("install-secret");
    if (app.id === "messaging-bridge") resources.push("bridge-cache");
    return resources;
}

/** What uninstalling does with each resource of this app's footprint. */
export function uninstallPlan(
    app: AppManifest,
    options: UninstallOptions
): Map<InstallResource, UninstallStep> {
    const plan = new Map<InstallResource, UninstallStep>();
    for (const resource of installFootprint(app)) plan.set(resource, stepFor(resource, options));
    return plan;
}

/** The resources this plan keeps, for a screen or a test to name. */
export function keptResources(plan: Map<InstallResource, UninstallStep>): InstallResource[] {
    return [...plan].filter(([, step]) => step.action === "keep").map(([resource]) => resource);
}

function stepFor(resource: InstallResource, { deleteData }: UninstallOptions): UninstallStep {
    switch (resource) {
        case "install-row":
            return deleteData
                ? { action: "remove", how: "row deleted" }
                : {
                      action: "keep",
                      why: "marked removed, secret cleared, so reinstalling finds its data"
                  };
        case "install-secret":
            return { action: "remove", how: "encrypted secret cleared from the row" };
        case "grants":
            return { action: "remove", how: "clearResourceGrants(installRef)" };
        case "presence":
            return { action: "remove", how: "invalidateInstallPresence + publishAccessChange" };
        case "app-bundle":
            return { action: "remove", how: "appUninstalled once nobody has the app" };
        case "owned-services":
            return deleteData
                ? { action: "remove", how: "each helper install uninstalled with its data" }
                : {
                      action: "keep",
                      why: "containers stopped, settings and data kept for a reinstall"
                  };
        case "install-data":
            return deleteData
                ? { action: "remove", how: "INSTALL_SCOPED_MODELS purged in one transaction" }
                : { action: "keep", why: "what people made in the app, kept for a reinstall" };
        case "install-files":
            return deleteData
                ? {
                      action: "remove",
                      how: "each app's purgeInstallFiles, before the rows that find the files"
                  }
                : { action: "keep", why: "the footage the kept rows point at, for a reinstall" };
        case "application":
        case "deployments":
        case "env-vars":
            return { action: "remove", how: "deleteApplication" };
        case "containers":
        case "network":
            return { action: "remove", how: "compose down / stack rm of every release" };
        case "volume-rows":
        case "domains":
        case "service-children":
            return { action: "remove", how: "cascade on the Application row" };
        case "volume-data":
            return deleteData
                ? {
                      action: "remove",
                      how: "wiped while the container is up, then the Docker volume removed"
                  }
                : {
                      action: "keep",
                      why: "a delete can be a mistake; leftover-volumes removes it after a week"
                  };
        case "edge-routes":
            return {
                action: "remove",
                how: "syncAppRoutes rewrites the file through writeDynamicFile"
            };
        case "quick-tunnel":
            return { action: "remove", how: "stopQuickTunnel" };
        case "firewall-rules":
            return { action: "remove", how: "WafRule rows scoped to the service deleted" };
        case "analytics":
            return deleteData
                ? { action: "remove", how: "AnalyticsSite scoped to the service deleted" }
                : { action: "keep", why: "collected history, deleted only with the data" };
        case "bridge-cache":
            return { action: "remove", how: "invalidateBridgeCache" };
        case "marketplace-project":
            return { action: "keep", why: "shared by every app the owner installs" };
        case "deploy-target":
            return { action: "keep", why: "the server itself, shared with everything else on it" };
        case "audit":
            return { action: "keep", why: "the audit trail records the uninstall too" };
    }
}

/**
 * The order an uninstall works in. Each phase starts once the one before it is
 * done, because it depends on it: nothing is unrouted while it still serves, a
 * network is only free once its containers are gone, and the data goes last so
 * a failure anywhere before it leaves the reader's data where it was. The
 * install's own rows go at the very end, so an uninstall that stops part-way is
 * still listed - with its Uninstall button - and running it again finishes it.
 */
export const UNINSTALL_PHASES = [
    "files",
    "stop",
    "unroute",
    "containers",
    "networks",
    "data",
    "rows",
    "after"
] as const;

export type UninstallPhase = (typeof UNINSTALL_PHASES)[number];

/** Which phase removes a resource. */
export function phaseOf(resource: InstallResource): UninstallPhase {
    switch (resource) {
        case "install-files":
            return "files";
        case "quick-tunnel":
        case "owned-services":
            return "stop";
        case "edge-routes":
        case "domains":
        case "firewall-rules":
            return "unroute";
        case "containers":
        case "deployments":
            return "containers";
        case "network":
            return "networks";
        case "volume-data":
        case "volume-rows":
        case "analytics":
        case "install-data":
            return "data";
        case "install-row":
        case "install-secret":
        case "grants":
        case "application":
        case "env-vars":
        case "service-children":
        case "marketplace-project":
        case "deploy-target":
            return "rows";
        case "presence":
        case "app-bundle":
        case "bridge-cache":
        case "audit":
            return "after";
    }
}

export interface OrderedStep {
    readonly phase: UninstallPhase;
    readonly resource: InstallResource;
    readonly step: UninstallStep;
}

/** The plan as the ordered list an uninstall carries out, phase by phase. */
export function uninstallSteps(app: AppManifest, options: UninstallOptions): OrderedStep[] {
    return [...uninstallPlan(app, options)]
        .map(([resource, step]) => ({ phase: phaseOf(resource), resource, step }))
        .sort((a, b) => UNINSTALL_PHASES.indexOf(a.phase) - UNINSTALL_PHASES.indexOf(b.phase));
}

/**
 * What an uninstall that failed in `failed` still has to remove: everything it
 * removes from that phase on. What the plan keeps is not left, it is kept.
 */
export function leftAfterFailure(
    steps: readonly OrderedStep[],
    failed: UninstallPhase
): InstallResource[] {
    const from = UNINSTALL_PHASES.indexOf(failed);
    return steps
        .filter((one) => one.step.action === "remove")
        .filter((one) => UNINSTALL_PHASES.indexOf(one.phase) >= from)
        .map((one) => one.resource);
}

/**
 * Which shared resources may go once `leaving` stops using them: only those
 * nobody else uses. Pure, so "never remove a network another app is on" is held
 * by a test rather than by care.
 */
export function freedShared(
    users: ReadonlyMap<string, readonly string[]>,
    leaving: ReadonlySet<string>
): string[] {
    return [...users]
        .filter(([, by]) => by.every((user) => leaving.has(user)))
        .map(([resource]) => resource)
        .sort();
}

/** Thrown when an uninstall stops part-way, with what is left, so the screen can
 *  say so and offer to try again. Running the uninstall again finishes it. */
export class UninstallIncompleteError extends Error {
    constructor(
        readonly phase: UninstallPhase,
        readonly left: readonly InstallResource[],
        cause: unknown
    ) {
        super(`uninstall stopped at ${phase}`, { cause });
        this.name = "UninstallIncompleteError";
    }
}
