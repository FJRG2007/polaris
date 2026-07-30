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
              select: { id: true, commitSha: true, isolated: true }
          })
        : null;
    if (!current?.isolated) return { ...base, portSubject: app.id };
    return { ...releaseRef(base, releaseMarker(current)), portSubject: current.id };
}
