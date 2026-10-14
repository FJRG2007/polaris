/**
 * What an application removed before Polaris cleaned up after itself left on
 * the machine Polaris runs on.
 *
 * An uninstall used to stop at the database row. The containers kept running or
 * sat exited, the private networks they were on stayed, the compose directory
 * the daemon wrote stayed, and the edge kept a route for a domain that no
 * longer existed until the next deploy rewrote the file. None of it is data,
 * all of it is Polaris's own doing, and none of it is anything an operator
 * should have to find by hand.
 *
 * Detection is one pure function over what the machine has and what Polaris
 * knows, so the one decision here that removes something is the tested part.
 * It only ever names things in the shapes Polaris itself creates
 * (`polaris-<8 hex>` projects, `polaris-net-` networks, `polaris-app-<id>`
 * routes), and only when the application they belong to is gone - so nothing
 * an operator made, and nothing of an application that is merely stopped, can
 * appear in it.
 *
 * Volumes are not here: they are data, and are listed with their sizes on the
 * same screen, one confirmation each.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { readFile } from "node:fs/promises";
import { HostdClient } from "@polaris/hostd-client";
import { dynamicPath } from "@/lib/traefik-dynamic";
import { APP_PROJECT, baseProject } from "./host-volumes";
import { wantedPrivateNetworks } from "./service-networks";
import { isPrivateNetwork, shortHash } from "@polaris/deploy";

/** One container as the daemon lists it, reduced to what the decision needs. */
export interface LiveContainer {
    readonly id: string;
    readonly name: string;
    readonly image: string;
    readonly project: string | null;
    readonly running: boolean;
    readonly status: string;
    readonly createdAt: string | null;
    /** The networks it is attached to, by name. */
    readonly networks: readonly string[];
}

/** What is on the machine. A null list is "the machine would not say". */
export interface LiveResources {
    readonly containers: readonly LiveContainer[];
    readonly networks: readonly string[] | null;
    readonly dirs: readonly string[] | null;
    /** The route ids `polaris-apps.yml` holds (see `routeIdsIn`). */
    readonly routes: readonly string[] | null;
}

/** What Polaris holds. A null set is "could not be read", and nothing that
 *  depends on it is offered. */
export interface KnownState {
    /** Every application's compose project, `polaris-<hash of its id>`. */
    readonly appProjects: ReadonlySet<string>;
    /** The private networks some environment, service or link still wants. */
    readonly wantedNetworks: ReadonlySet<string> | null;
    /** Every domain row id. */
    readonly domainIds: ReadonlySet<string> | null;
}

/** A container left by a removed application. */
export type LeftoverContainer = Omit<LiveContainer, "networks"> & { readonly project: string };

export interface Leftovers {
    readonly containers: readonly LeftoverContainer[];
    readonly networks: readonly string[];
    readonly dirs: readonly string[];
    /** Route ids in the edge's file whose domain or application is gone. */
    readonly routes: readonly string[];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTE_NAME = new RegExp(`^\\s+polaris-app-(${UUID}|qtunnel-[0-9a-f]{8})\\b`, "gm");

/** The route ids an edge file names, once each: a domain's id, or
 *  `qtunnel-<hash>` for an application's tunnel address. */
export function routeIdsIn(yaml: string): string[] {
    return [...new Set([...yaml.matchAll(ROUTE_NAME)].map((match) => match[1]!))];
}

/** Whether a compose project is an application's and that application is gone. */
function removedProject(project: string | null, known: KnownState): project is string {
    if (!project || !APP_PROJECT.test(project)) return false;
    return !known.appProjects.has(baseProject(project) ?? project);
}

/**
 * Everything on the machine that a removed application left behind. Pure.
 *
 * A network counts only when nothing still wants it and every container on it
 * is itself a leftover - those go first in the same clean-up, so the network is
 * empty by the time it is removed, and the daemon refuses it otherwise.
 */
export function findLeftovers(live: LiveResources, known: KnownState): Leftovers {
    const containers = live.containers
        .filter((entry) => removedProject(entry.project, known))
        .map(({ networks: _networks, ...entry }) => entry as LeftoverContainer)
        .sort((left, right) => left.name.localeCompare(right.name));
    const leaving = new Set(containers.map((entry) => entry.id));

    const wanted = known.wantedNetworks;
    const networks = wanted
        ? (live.networks ?? []).filter(
              (name) =>
                  isPrivateNetwork(name) &&
                  !wanted.has(name) &&
                  live.containers.every(
                      (entry) => !entry.networks.includes(name) || leaving.has(entry.id)
                  )
          )
        : [];

    const dirs = (live.dirs ?? []).filter((dir) => removedProject(dir, known));

    const domains = known.domainIds;
    const routes = domains
        ? (live.routes ?? []).filter((id) =>
              id.startsWith("qtunnel-")
                  ? !known.appProjects.has(`polaris-${id.slice("qtunnel-".length)}`)
                  : !domains.has(id)
          )
        : [];

    return { containers, networks: [...networks].sort(), dirs: [...dirs].sort(), routes };
}

interface DockerContainer {
    Id?: string;
    Names?: string[];
    Image?: string;
    State?: string;
    Status?: string;
    Created?: number;
    Labels?: Record<string, string> | null;
    NetworkSettings?: { Networks?: Record<string, unknown> | null } | null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** The daemon's container listing in the shape `findLeftovers` reads. Pure. */
export function liveContainers(listing: readonly DockerContainer[]): LiveContainer[] {
    const out: LiveContainer[] = [];
    for (const entry of listing) {
        const id = text(entry.Id);
        if (!id) continue;
        out.push({
            id,
            name: text(entry.Names?.[0])?.replace(/^\//, "") ?? id.slice(0, 12),
            image: text(entry.Image) ?? "unknown image",
            project: text(entry.Labels?.["com.docker.compose.project"]),
            running: entry.State === "running",
            status: text(entry.Status) ?? "",
            createdAt:
                typeof entry.Created === "number" && Number.isFinite(entry.Created)
                    ? new Date(entry.Created * 1000).toISOString()
                    : null,
            networks: Object.keys(entry.NetworkSettings?.Networks ?? {})
        });
    }
    return out;
}

async function readJson(daemon: HostdClient, path: string): Promise<unknown[] | null> {
    const reply = await daemon.dockerRequest("GET", path).catch(() => null);
    if (!reply || reply.status !== 200) return null;
    try {
        const parsed: unknown = JSON.parse(reply.body);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** The application projects Polaris holds, or null when they cannot be read -
 *  an empty answer from a database that did not answer would make every
 *  application on the machine look removed. */
export async function knownAppProjects(): Promise<Set<string> | null> {
    const apps = await prisma.application.findMany({ select: { id: true } }).catch(() => null);
    return apps ? new Set(apps.map((app) => `polaris-${shortHash(app.id, 8)}`)) : null;
}

/** What is on this machine, read through the daemon and the edge's file. Null
 *  when the daemon will not list containers. */
async function liveResources(): Promise<LiveResources | null> {
    const daemon = new HostdClient();
    const [listing, networks, dirs, routes] = await Promise.all([
        readJson(daemon, "/containers/json?all=1"),
        readJson(daemon, "/networks"),
        daemon.deployDirs().catch(() => null),
        readFile(dynamicPath("polaris-apps.yml"), "utf8")
            .then(routeIdsIn)
            .catch(() => null)
    ]);
    if (!listing) return null;
    return {
        containers: liveContainers(listing as DockerContainer[]),
        networks: networks
            ? networks
                  .map((entry) => text((entry as { Name?: unknown }).Name))
                  .filter((name): name is string => name !== null)
            : null,
        dirs,
        routes
    };
}

/** What Polaris holds, or null when its applications cannot be read. */
async function knownState(): Promise<KnownState | null> {
    const [appProjects, wanted, domains] = await Promise.all([
        knownAppProjects(),
        wantedPrivateNetworks().catch(() => null),
        prisma.domain.findMany({ select: { id: true } }).catch(() => null)
    ]);
    if (!appProjects) return null;
    return {
        appProjects,
        wantedNetworks: wanted ? new Set(wanted) : null,
        domainIds: domains ? new Set(domains.map((row) => row.id)) : null
    };
}

/** The leftovers on this machine, or null when it or Polaris would not say. */
export async function hostLeftovers(): Promise<Leftovers | null> {
    const [live, known] = await Promise.all([liveResources(), knownState()]);
    return live && known ? findLeftovers(live, known) : null;
}

/** What a clean-up did, and what it could not. */
export interface LeftoverCleanup {
    readonly removed: { containers: number; networks: number; dirs: number; routes: number };
    readonly failed: number;
}

/**
 * Remove every non-data leftover, freshly detected: the list a screen showed is
 * a picture of a moment, and a deploy since may have made something real again.
 * Containers first (never their volumes), then the networks they emptied, then
 * the directories, then the edge's file rewritten from what Polaris holds.
 */
export async function cleanLeftovers(): Promise<LeftoverCleanup | null> {
    const found = await hostLeftovers();
    if (!found) return null;
    const daemon = new HostdClient();
    const removed = { containers: 0, networks: 0, dirs: 0, routes: 0 };
    let failed = 0;

    for (const container of found.containers) {
        const reply = await daemon
            .dockerRequest("DELETE", `/containers/${encodeURIComponent(container.id)}?force=1&v=0`)
            .catch(() => null);
        if (reply?.status === 204 || reply?.status === 404) removed.containers += 1;
        else failed += 1;
    }
    for (const name of found.networks) {
        const reply = await daemon
            .dockerRequest("DELETE", `/networks/${encodeURIComponent(name)}`)
            .catch(() => null);
        if (reply?.status === 204 || reply?.status === 404) removed.networks += 1;
        else failed += 1;
    }
    for (const dir of found.dirs) {
        const ok = await daemon.removeDeployDir(dir).then(
            () => true,
            () => false
        );
        if (ok) removed.dirs += 1;
        else failed += 1;
    }
    if (found.routes.length > 0) {
        // The file is rendered whole from what Polaris holds and written through
        // `writeDynamicFile`, so a route for a domain that is gone simply is not in
        // the next one.
        const { syncAppRoutes } = await import("@/lib/deploy-service");
        const ok = await syncAppRoutes().then(
            () => true,
            () => false
        );
        if (ok) removed.routes = found.routes.length;
        else failed += found.routes.length;
    }
    return { removed, failed };
}
