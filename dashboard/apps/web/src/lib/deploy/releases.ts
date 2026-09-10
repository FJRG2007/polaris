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
 * How many kept releases stay running, newest first. Older ones are torn down as
 * each new release is promoted, so a long history cannot quietly fill the host.
 */
export const KEPT_RELEASES = 3;

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
    return { name: serviceName(projectSlug, appSlug, appId), project: `polaris-${shortHash(appId, 8)}` };
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
 * The new release runs in a project of its own under a name of its own, and also
 * answers to the service's own name on the proxy network - which is how the edge,
 * a tunnel and every other service find it - so the change-over moves no address
 * at all. The one it replaced is taken down once the new one is serving. With
 * several copies, every copy of the new release answers to the service's name for
 * that copy as well (see `expandReplicas`), so the edge's route - which names each
 * copy - reaches the new copies the same way, keeping its sticky cookie and health
 * path, and is never rewritten for it. Never rewritten on purpose: a route that
 * named the new release's own containers would need the edge to take a new file
 * before the old copies went, and an edge frozen on its last good configuration by
 * one bad file elsewhere would go on dialling copies that no longer exist.
 *
 * Only where two copies can run at once without stepping on each other: no
 * volume (both would hold the same files), nothing published on the host (both
 * would want the same port), and not a compose file of the owner's own, whose
 * names are its own business. A service that keeps its releases already runs them
 * side by side.
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
    app: {
        keepReleases: boolean;
        publishPort: boolean;
        sourceType: string;
        sourceConfig: string;
        volumes: readonly unknown[];
        target: { runtime: string };
    },
    edge: { readonly followsPushedRoutes: boolean }
): boolean {
    if (app.keepReleases || app.publishPort || app.sourceType === "compose" || !edge.followsPushedRoutes) return false;
    if (app.volumes.length > 0 || app.target.runtime !== "compose") return false;
    try {
        const source = JSON.parse(app.sourceConfig) as { extraPorts?: unknown };
        return !Array.isArray(source.extraPorts) || source.extraPorts.length === 0;
    } catch {
        return false;
    }
}

/**
 * The marker a release's project and container carry. A change-over release is
 * named after the deployment itself, so a redeploy of the same commit still comes
 * up beside the one it replaces rather than on top of it; a kept release is named
 * after its commit, which is also what its hostname carries.
 */
export function markerOf(deployment: { id: string; commitSha?: string | null; cutover?: boolean }): string {
    return deployment.cutover ? releaseMarker({ id: deployment.id }) : releaseMarker(deployment);
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
export function portSubject(appId: string, current: { id: string; isolated: boolean } | null): string {
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
    const base = serviceRef(app.environment.project.slug, app.slug, app.id);
    const current = app.currentDeploymentId
        ? await prisma.deployment.findUnique({
              where: { id: app.currentDeploymentId },
              select: { id: true, commitSha: true, isolated: true, cutover: true }
          })
        : null;
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
export async function servingContainerNames(apps: readonly ReleaseSubject[]): Promise<Map<string, string>> {
    const ids = apps.map((app) => app.currentDeploymentId).filter((id): id is string => id !== null);
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
            const current = app.currentDeploymentId ? releases.get(app.currentDeploymentId) : undefined;
            return [app.id, current ? releaseRef(base, markerOf(current)).name : base.name];
        })
    );
}
