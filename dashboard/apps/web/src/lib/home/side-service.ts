/**
 * The containers Home runs for itself, and how to reach one.
 *
 * Three of them now - the relay that holds each camera's single connection, the
 * worker that looks at pixels, and the recognizer that says who somebody is - and
 * they are all found and dialled the same way. Each is a deploy on a server the
 * owner picked, so "where is it" is the same question every time: the server's
 * own address and the app's stable port when Polaris and that machine are on
 * speaking terms, and the SSH connection Polaris already has when they are not.
 *
 * None of these are offered in the marketplace. They exist because a camera
 * needed one, and they are useless on their own.
 *
 * Server-only.
 */

import { Socket } from "node:net";
import { HomeError } from "@/lib/home/home-error";

import { prisma } from "@polaris/db";
import { listHosts } from "@/lib/host-service";
import { localDialHost } from "@/lib/deploy/dial";
import { tunnelledUrl } from "@/lib/home/tunnel";
import { findApp } from "@/lib/apps/catalog";
import { serviceRef } from "@/lib/deploy/releases";
import { hostPortForApp } from "@/lib/deploy-service";

/** One of Home's own containers, as found on a server. */
export interface SideService {
    readonly installedAppId: string;
    readonly applicationId: string;
    readonly ownerId: string;
}

/** The two addresses one of them answers on. */
export interface ServiceUrls {
    /**
     * How Polaris dials it. Usually the server's own address; for a machine whose
     * high ports nobody forwards, a loopback address that tunnels through the SSH
     * connection Polaris already has to it.
     */
    readonly baseUrl: string;
    /**
     * How something ON that machine dials it. The vision worker runs beside the
     * relay, so it must be given the real address rather than a tunnel that only
     * exists inside the Polaris process.
     */
    readonly directUrl: string;
    /**
     * How another container Polaris started dials it: the container's own name,
     * on the network they share, at the port it actually listens on.
     *
     * This is the address that should be handed to a worker, and the reason is a
     * bug that hid for as long as the feature existed. `directUrl` goes out to
     * the host and back in - which works for Polaris, whose own compose file
     * gives it the name of the machine it runs on, and does not work for a
     * container Polaris deployed, which was never given that name. The worker's
     * ffmpeg exited on the spot, over and over, and its error went to a stderr
     * nothing reads: what the operator saw was a camera that had noticed nothing
     * since the day it was added.
     *
     * Container to container is also simply the right path. It stays on the
     * bridge, needs no published port, and cannot be sent out to a router and
     * back.
     *
     * Null when the service is on another machine, where there is no shared
     * network and the address means nothing.
     */
    readonly networkUrl: string | null;
}

/** The deploy target a server id resolves to, when one already exists. Null for a
 *  server that has never had anything deployed on it, which is also the case
 *  where none of these can be found. */
export async function targetIdFor(serverId: string): Promise<string | null> {
    if (serverId === "local") {
        const local = await prisma.deployTarget.findFirst({ where: { kind: "local" }, select: { id: true } });
        return local?.id ?? null;
    }
    const target = await prisma.deployTarget.findFirst({ where: { hostId: serverId }, select: { id: true } });
    return target?.id ?? null;
}

/** One of Home's services on one server, or null when that server has none. */
export async function findService(catalogId: string, serverId: string): Promise<SideService | null> {
    const targetId = await targetIdFor(serverId);
    const row = await prisma.installedApp.findFirst({
        where: {
            catalogId,
            status: { not: "removed" },
            applicationId: { not: null },
            ...(targetId ? { targetId } : {})
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, applicationId: true, ownerId: true }
    });
    return row?.applicationId
        ? { installedAppId: row.id, applicationId: row.applicationId, ownerId: row.ownerId }
        : null;
}

/**
 * Where one of them answers.
 *
 * The direct address is how every other deployed app is dialled, and it works
 * whenever Polaris and the server are on speaking terms - the ordinary case and
 * the fast one. When it does not answer, the service is on a machine Polaris can
 * only reach through SSH: a second router, a guest network, another building.
 * Rather than asking somebody to forward another port, the traffic comes back
 * down that SSH connection. Which of the two is in use is decided by knocking
 * once and remembering the answer, so it costs nothing per request.
 */
export async function serviceUrls(applicationId: string, ownerId: string): Promise<ServiceUrls | null> {
    const application = await prisma.application.findFirst({
        where: { id: applicationId },
        select: { target: { select: { kind: true, hostId: true, host: { select: { address: true } } } } }
    });
    if (!application) return null;
    const local = application.target.kind === "local";
    // The same address the edge dials a locally deployed app on, and for the
    // reason spelled out in lib/deploy/dial: the box's public address sends this
    // traffic out to the router and back in. For a page that is one request that
    // is merely wasteful; for video it is every byte of every stream taking a
    // round trip through the router, which is exactly what a camera that "takes
    // ages and then stutters" looks like.
    const dialHost = local ? await localDialHost() : (application.target.host?.address?.trim() ?? null);
    if (!dialHost) return null;

    const port = hostPortForApp(applicationId);
    const directUrl = `http://${dialHost}:${port}`;
    const networkUrl = local ? await containerUrl(applicationId) : null;
    const hostId = application.target.hostId;
    if (local || !hostId) return { baseUrl: directUrl, directUrl, networkUrl };

    if (await reachable(dialHost, port)) return { baseUrl: directUrl, directUrl, networkUrl };
    // A tunnel that cannot be opened is not a reason to answer nothing: the
    // direct address is still the best guess, and the caller's own failure says
    // more than a silent null would.
    const tunnelled = await tunnelledUrl(hostId, ownerId, "127.0.0.1", port).catch(() => null);
    return { baseUrl: tunnelled ?? directUrl, directUrl, networkUrl };
}

/**
 * The address this service answers on from inside the network Polaris deploys
 * onto: its container's name and the port that container actually listens on.
 *
 * Both halves are the deployment's own, so neither is guessed. The name is the
 * one the runtime writes as `container_name`, which is what Docker answers on
 * the shared bridge; the port is the one the app's manifest declares, not the
 * one it is published on outside.
 */
async function containerUrl(applicationId: string): Promise<string | null> {
    const application = await prisma.application.findFirst({
        where: { id: applicationId },
        select: { id: true, slug: true, environment: { select: { project: { select: { slug: true } } } } }
    });
    if (!application?.environment?.project) return null;
    const install = await prisma.installedApp.findFirst({
        where: { applicationId },
        select: { catalogId: true }
    });
    const port = install ? findApp(install.catalogId)?.template?.ports?.[0]?.container : undefined;
    if (!port) return null;
    const { name } = serviceRef(application.environment.project.slug, application.slug, application.id);
    return `http://${name}:${port}`;
}

/** Refuse a server id that names nothing before installing onto it. */
export async function assertServer(ownerId: string, serverId: string): Promise<void> {
    if (serverId === "local") return;
    const hosts = await listHosts(ownerId);
    if (!hosts.some((host) => host.id === serverId)) throw new HomeError("That server is not connected");
}

/** Whether a port answers, remembered for a while.
 *
 *  Asked once per service rather than per request: the answer is a fact about the
 *  network between two machines, and it does not change between two clicks. */
const reachability = new Map<string, { open: boolean; at: number }>();
const REACHABILITY_TTL_MS = 5 * 60_000;

function reachable(host: string, port: number): Promise<boolean> {
    const key = `${host}:${port}`;
    const known = reachability.get(key);
    if (known && Date.now() - known.at < REACHABILITY_TTL_MS) return Promise.resolve(known.open);
    return new Promise((resolve) => {
        const socket = new Socket();
        const answer = (open: boolean) => {
            socket.destroy();
            reachability.set(key, { open, at: Date.now() });
            resolve(open);
        };
        socket.setTimeout(1500);
        socket.once("connect", () => answer(true));
        socket.once("timeout", () => answer(false));
        socket.once("error", () => answer(false));
        socket.connect(port, host);
    });
}
