/**
 * Multi-version releases. A service that keeps its history runs each build in its
 * own compose project, so an older version stays up and reachable while the newest
 * one takes over the service's address - the way Vercel and Railway present it:
 * one address for the service, one more per build.
 *
 * The naming lives here rather than in the pipeline because everything that
 * reaches into a container (terminal, file browser, runtime logs, status) has to
 * resolve the same pair of names, and they must agree exactly.
 *
 * A service that does not keep history is untouched: it keeps the single project
 * and container name it has always had, and a deploy replaces what is there.
 */

import { prisma } from "@polaris/db";
import { serviceName, shortHash, slugify } from "@polaris/deploy";

/**
 * How many kept releases stay running, newest first.
 *
 * One: the newest. Older ones are torn down as each new release is promoted, so
 * a service that keeps its history keeps the addresses of its past builds and
 * not their containers - it was three, which is three copies of a service
 * running for every service that has the setting on, on a host that has to fit
 * all of them.
 */
export const KEPT_RELEASES = 1;

/** Longest container name DNS (and docker) will take. */
const MAX_NAME = 63;

/** The compose project and container name a build runs under. */
export interface ReleaseRef {
    readonly name: string;
    readonly project: string;
}

/**
 * What names a release in a hostname and a container: its commit when there is
 * one, else the deployment itself. Short and DNS-safe either way, so the same
 * marker can be read off a URL and off `docker ps`.
 */
export function releaseMarker(deployment: { id: string; commitSha?: string | null }): string {
    return slugify(deployment.commitSha ?? "").slice(0, 7) || shortHash(deployment.id, 7);
}

/** The single project and container a service uses when it does not keep history.
 *  Unchanged from what every existing service already runs under. */
export function serviceRef(projectSlug: string, appSlug: string, appId: string): ReleaseRef {
    return {
        name: serviceName(projectSlug, appSlug, appId),
        project: `polaris-${shortHash(appId, 8)}`
    };
}

/**
 * The project and container one kept release runs under: the service's own, plus
 * the release marker, so it stands beside the releases before and after it instead
 * of replacing them. The marker is kept whole and the service name gives way if
 * the pair would outgrow a DNS label - two releases with the same truncated name
 * would be the same container.
 */
export function releaseRef(base: ReleaseRef, marker: string): ReleaseRef {
    const room = MAX_NAME - marker.length - 1;
    return { name: `${base.name.slice(0, room)}-${marker}`, project: `${base.project}-${marker}` };
}

/**
 * Whether a service really runs its releases side by side.
 *
 * Two conditions have to hold beyond the setting itself. Attached storage cannot
 * take it - two versions running at once would hold the same files open - so a
 * service with a volume hands it over to the newest build instead, and its history
 * stays a record rather than a running copy. And it is for services on this host,
 * whose edge is re-pointed from the domain records: on another server the routing
 * is carried by the container's own labels, so the release standing beside the new
 * one would still be claiming the service's address, and which of the two answered
 * would be anyone's guess.
 *
 * In both cases the setting still holds its history; only the older containers go.
 */
export function keepsReleases(app: {
    keepReleases: boolean;
    volumes: readonly unknown[];
    target: { kind: string };
}): boolean {
    return app.keepReleases && app.volumes.length === 0 && app.target.kind === "local";
}

/**
 * Whether a deploy of this service starts the new version beside the running one
 * and changes over once it is serving, instead of replacing it in place.
 *
 * The new release runs in a project of its own under a name of its own, beside
 * the one serving. It also answers to the service's own name on the networks it
 * joins, which is how every other service and a tunnel connector reach it, so for
 * them the change-over moves no address. The edge is different: it dials the
 * serving release by its own container names (`edgeDialName`), and the new one is
 * written into its route only once it is promoted - after it came up, passed its
 * healthcheck and opened its port. So the old release takes every request from the
 * edge until then, the switch is one atomic file write, and the old one is drained
 * and taken down only once the edge has been told (see `promoteDeployment`). With
 * several copies the route names each copy of the serving release, keeping its
 * sticky cookie and health path. A release that does not come up is taken down and
 * the route never named it.
 *
 * Only where two copies can run at once without stepping on each other: nothing
 * published on the host (both would want the same port), not a compose file of
 * the owner's own, whose names are its own business, and no volume unless the
 * owner said two copies may share them for the seconds of the change-over
 * (`overlapVolumes`) - a program that locks its data directory, or a database file
 * one process writes, would fail or be corrupted by a second copy. A service that
 * keeps its releases already runs them side by side.
 *
 * And only where the edge in front of it dials the service by name from routes
 * Polaris writes (`edge`). This host's always does. Another server's does once it
 * was prepared by a Polaris that pushes routes to it, and those routes rank above
 * the ones each container declares in its labels. An older server's edge reads the
 * labels alone, where both releases claim the address at the same rank and the old
 * one is dialled by its own address rather than a name - so as its copies stop, the
 * requests that edge still sends them fail. Such a server is recreated in place
 * until it is prepared again. A domain another server's service has served through
 * Polaris is dialled on the host port that server publishes, which is the
 * published-port case already refused here.
 */
export function runsCutover(
    app: CutoverSubject,
    edge: { readonly followsPushedRoutes: boolean }
): boolean {
    return (
        !app.keepReleases &&
        app.target.runtime === "compose" &&
        restartReasons(app, edge).length === 0
    );
}

/** What `runsCutover` and `deployStrategy` read about a service. */
export interface CutoverSubject {
    readonly id?: string;
    readonly keepReleases: boolean;
    readonly publishPort: boolean;
    readonly sourceType: string;
    readonly sourceConfig: string;
    readonly volumes: readonly { readonly name?: string }[];
    /** Whether two copies may share the volumes for the change-over. */
    readonly overlapVolumes?: boolean;
    readonly target: { readonly runtime: string; readonly kind?: string };
}

/** Why a deploy stops the running version before it starts the new one. */
export type RestartReason =
    | { readonly code: "hostPort"; readonly port: number; readonly protocol: "tcp" | "udp" }
    | { readonly code: "volumes"; readonly names: readonly string[] }
    | { readonly code: "newVolumes"; readonly names: readonly string[] }
    | { readonly code: "compose" }
    | { readonly code: "edge" }
    | { readonly code: "history" }
    | { readonly code: "unreadable" };

/**
 * How a deploy of this service replaces the running version, as the screen says it:
 *
 * - `overlap`: the new version starts beside the old one, the edge is switched to
 *   it once it serves, and the old one is drained and stopped.
 * - `kept`: every release runs in its own project on its own port, and the edge is
 *   re-pointed at the newest once it serves.
 * - `swarm`: the engine replaces it start-first and rolls back by itself.
 * - `restart`: stopped, then started - with every reason it has to be.
 */
export type DeployStrategy =
    | { readonly mode: "overlap" | "kept" | "swarm" }
    | { readonly mode: "restart"; readonly reasons: readonly RestartReason[] };

/**
 * Every reason a deploy of this service has to stop the running version first.
 * Empty means nothing stops two copies running at once. Read by the deploy, which
 * acts on it, and by the screen, which says it - so the two never disagree.
 */
export function restartReasons(
    app: CutoverSubject,
    edge: { readonly followsPushedRoutes: boolean },
    hostPortOf: (id: string) => number = () => 0
): RestartReason[] {
    const reasons: RestartReason[] = [];
    let source: { hostPort?: unknown; hostProtocol?: unknown; extraPorts?: unknown; tcpProxies?: unknown };
    try {
        source = JSON.parse(app.sourceConfig) as typeof source;
    } catch {
        return [{ code: "unreadable" }];
    }
    if (app.publishPort) {
        reasons.push({
            code: "hostPort",
            port: typeof source.hostPort === "number" ? source.hostPort : hostPortOf(app.id ?? ""),
            protocol: source.hostProtocol === "udp" ? "udp" : "tcp"
        });
    }
    for (const list of [source.extraPorts, source.tcpProxies]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list as { host?: unknown; protocol?: unknown }[]) {
            if (typeof entry?.host !== "number") continue;
            reasons.push({
                code: "hostPort",
                port: entry.host,
                protocol: entry.protocol === "udp" ? "udp" : "tcp"
            });
        }
    }
    if (app.sourceType === "compose") reasons.push({ code: "compose" });
    // Swarm never lets two tasks share a volume (`forSwarm`), whatever the setting.
    if (app.volumes.length > 0 && (!app.overlapVolumes || app.target.runtime !== "compose")) {
        reasons.push({
            code: "volumes",
            names: app.volumes.map((volume) => volume.name ?? "").filter(Boolean)
        });
    }
    if (!edge.followsPushedRoutes && app.target.runtime === "compose")
        reasons.push({ code: "edge" });
    return reasons;
}

/** How a deploy of this service replaces what runs - see `DeployStrategy`. */
export function deployStrategy(
    app: CutoverSubject,
    edge: { readonly followsPushedRoutes: boolean },
    hostPortOf?: (id: string) => number
): DeployStrategy {
    if (app.target.runtime === "swarm") {
        const volumes = app.volumes.length > 0;
        return volumes
            ? {
                  mode: "restart",
                  reasons: restartReasons({ ...app, publishPort: false, sourceConfig: "{}" }, edge)
              }
            : { mode: "swarm" };
    }
    if (app.keepReleases) {
        if (keepsReleases({ ...app, target: { kind: app.target.kind ?? "local" } }))
            return { mode: "kept" };
    }
    const reasons = restartReasons(app, edge, hostPortOf);
    if (reasons.length === 0 && !app.keepReleases) return { mode: "overlap" };
    // A service set to keep its releases where it cannot (another server) is
    // replaced in place, and says that is why when nothing else does.
    return { mode: "restart", reasons: reasons.length > 0 ? reasons : [{ code: "history" }] };
}

/**
 * The named volumes a change-over release would mount that do not exist yet. It
 * mounts them by name as external, which Docker refuses for a volume nobody made
 * yet - and the one that makes them is a deploy in the service's own project. So
 * a service deploying for the first time, or with a volume added since its running
 * release started, is deployed in place this once and changes over from then on.
 */
export async function volumesNotYetMade(app: {
    readonly currentDeploymentId: string | null;
    readonly volumes: readonly {
        readonly name: string;
        readonly kind: string;
        readonly createdAt: Date;
    }[];
}): Promise<string[]> {
    const named = app.volumes.filter((volume) => volume.kind !== "bind" && volume.kind !== "nas");
    if (named.length === 0) return [];
    const current = app.currentDeploymentId
        ? await prisma.deployment.findUnique({
              where: { id: app.currentDeploymentId },
              select: { status: true, startedAt: true, createdAt: true }
          })
        : null;
    if (current?.status !== "running") return named.map((volume) => volume.name);
    const since = current.startedAt ?? current.createdAt;
    return named.filter((volume) => volume.createdAt > since).map((volume) => volume.name);
}

/**
 * The marker a release's project and container carry. A change-over release is
 * named after the deployment itself, so a redeploy of the same commit still comes
 * up beside the one it replaces rather than on top of it; a kept release is named
 * after its commit, which is also what its hostname carries.
 */
export function markerOf(deployment: {
    id: string;
    commitSha?: string | null;
    cutover?: boolean;
}): string {
    return deployment.cutover ? releaseMarker({ id: deployment.id }) : releaseMarker(deployment);
}

/**
 * The container the edge dials for a service: the one the release serving it runs
 * under. A change-over release is dialled by its own name, not by the service's
 * name it also answers to - that alias is live from the moment its container
 * starts, so dialling it would send visitors to a version that has not proved it
 * serves yet. Its own name is only written into the route when it is promoted,
 * after it came up and opened its port, which is what makes the switch a
 * switch: the old release takes every request until then, and none after the edge
 * takes the new file. The alias stays for everything that reaches the service
 * from inside (another service, a tunnel connector), which is never re-pointed.
 */
export function edgeDialName(
    base: ReleaseRef,
    current: { readonly id: string; readonly cutover: boolean } | null | undefined
): string {
    return current?.cutover
        ? releaseRef(base, markerOf({ id: current.id, cutover: true })).name
        : base.name;
}

/**
 * What a service's published host port is derived from: the release serving it
 * when that release runs in a project of its own (each such release publishes on a
 * port of its own), else the service itself. Keeps the direct IP:port link and the
 * edge route pointing at the same socket.
 *
 * Read off the deployment rather than the current setting: turning the setting off
 * must not move a running version out from under the address serving it.
 */
export function portSubject(
    appId: string,
    current: { id: string; isolated: boolean } | null
): string {
    return current?.isolated ? current.id : appId;
}

/**
 * Which kept release images have fallen out of a service's rollback window.
 *
 * `rows` are the service's deployments that still have a kept image, newest
 * first. The live one and any pinned one always stay; after them the newest
 * `window` distinct images stay. Counted in images rather than rows because a
 * rollback runs an image another deployment already kept - two rows, one image,
 * and removing it for the older row would pull it out from under the newer.
 */
export function imagesOutsideWindow(
    rows: readonly { id: string; imageTag: string | null; pinned: boolean }[],
    currentId: string | null,
    window: number
): string[] {
    const keep = new Set<string>();
    for (const row of rows) {
        if (row.imageTag && (row.id === currentId || row.pinned)) keep.add(row.imageTag);
    }
    let counted = 0;
    for (const row of rows) {
        if (!row.imageTag || keep.has(row.imageTag)) continue;
        if (counted >= window) continue;
        keep.add(row.imageTag);
        counted += 1;
    }
    return [
        ...new Set(
            rows.flatMap((row) => (row.imageTag && !keep.has(row.imageTag) ? [row.imageTag] : []))
        )
    ];
}

/** The shape any caller needs loaded to resolve which release is serving. */
export interface ReleaseSubject {
    id: string;
    slug: string;
    currentDeploymentId: string | null;
    environment: { project: { slug: string } };
}

/** A service's own names plus the release currently serving it, resolved once. */
export interface ServingRelease extends ReleaseRef {
    /** What the published host port is derived from (see `portSubject`). */
    readonly portSubject: string;
    /** The name other containers reach it by: the service's own wherever that
     *  answers - a change-over release carries it as an alias - else the release's. */
    readonly address: string;
}

/**
 * The project and container a service is served from right now: its own pair, or -
 * when the release serving it runs in a project of its own - that release's pair.
 * Everything that reaches into a container (terminal, file browser, runtime logs,
 * status, restart) resolves through this, so none of them ends up talking to a name
 * nothing answers on.
 */
export async function currentReleaseRef(app: ReleaseSubject): Promise<ServingRelease> {
    const current = app.currentDeploymentId
        ? await prisma.deployment.findUnique({
              where: { id: app.currentDeploymentId },
              select: { id: true, commitSha: true, isolated: true, cutover: true }
          })
        : null;
    return servedBy(app, current);
}

/**
 * `currentReleaseRef` for many services at once: one query for all of them, for a
 * screen that lists every service of a project.
 */
export async function servingReleases(
    apps: readonly ReleaseSubject[]
): Promise<Map<string, ServingRelease>> {
    const ids = apps
        .map((app) => app.currentDeploymentId)
        .filter((id): id is string => id !== null);
    const deployments = new Map(
        (ids.length > 0
            ? await prisma.deployment.findMany({
                  where: { id: { in: ids } },
                  select: { id: true, commitSha: true, isolated: true, cutover: true }
              })
            : []
        ).map((row) => [row.id, row])
    );
    return new Map(
        apps.map((app) => [
            app.id,
            servedBy(
                app,
                app.currentDeploymentId ? (deployments.get(app.currentDeploymentId) ?? null) : null
            )
        ])
    );
}

/** Which release serves a service, given the deployment it currently points at. */
function servedBy(
    app: ReleaseSubject,
    current: { id: string; commitSha: string | null; isolated: boolean; cutover: boolean } | null
): ServingRelease {
    const base = serviceRef(app.environment.project.slug, app.slug, app.id);
    if (!current?.isolated) return { ...base, portSubject: app.id, address: base.name };
    const release = releaseRef(base, markerOf(current));
    // A change-over release publishes nothing, so the service's own port is the one
    // any link names, and it answers to the service's own name.
    return current.cutover
        ? { ...release, portSubject: app.id, address: base.name }
        : { ...release, portSubject: current.id, address: release.name };
}

/**
 * The container each service is served from right now, for many services at once:
 * one query for all of them rather than `currentReleaseRef` per service, for a
 * caller that walks every service on a machine.
 */
export async function servingContainerNames(
    apps: readonly ReleaseSubject[]
): Promise<Map<string, string>> {
    const ids = apps
        .map((app) => app.currentDeploymentId)
        .filter((id): id is string => id !== null);
    const releases = new Map(
        (ids.length > 0
            ? await prisma.deployment.findMany({
                  where: { id: { in: ids }, isolated: true },
                  select: { id: true, commitSha: true, cutover: true }
              })
            : []
        ).map((row) => [row.id, row])
    );
    return new Map(
        apps.map((app) => {
            const base = serviceRef(app.environment.project.slug, app.slug, app.id);
            const current = app.currentDeploymentId
                ? releases.get(app.currentDeploymentId)
                : undefined;
            return [app.id, current ? releaseRef(base, markerOf(current)).name : base.name];
        })
    );
}
