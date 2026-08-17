/**
 * The one connection per camera, and everybody who watches it.
 *
 * A camera will nearly always allow exactly one connection to its good stream.
 * Two people opening the wall at once is enough to break that, and so is one
 * person watching while a detector looks at the same stream. So nothing in
 * Polaris ever opens a camera directly: the relay holds the single connection
 * and re-serves it, without re-encoding anything, to as many viewers as there
 * are. That is also why the whole thing costs almost nothing - copying packets
 * is not the expensive part of video, decoding is, and nothing here decodes.
 *
 * The relay is a marketplace app installed on demand: a house with no camera
 * runs nothing at all, and the first camera brings one up on the machine it was
 * told to use. A camera on a network Polaris cannot see gets a relay on a server
 * that CAN see it, which is what makes that camera reachable at all.
 *
 * Server-only.
 */

import { Socket } from "node:net";
import { prisma } from "@polaris/db";
import { tunnelledUrl } from "@/lib/home/tunnel";
import { listHosts } from "@/lib/host-service";
import { relaySource } from "@/lib/home/vendors";
import { getPublicIp } from "@/lib/domain-service";
import { hostPortForApp } from "@/lib/deploy-service";
import type { CameraTarget } from "@/lib/home/cameras";
import { installApp } from "@/lib/apps/install-service";
import { installEnvSecret, installEnvValue } from "@/lib/apps/install-secret";

/** The catalog app this module installs and talks to. */
const RELAY_APP = "camera-hub";

/** Where a relay is, and how to prove to it that this is Polaris asking. */
export interface RelayEndpoint {
    readonly installedAppId: string;
    /**
     * How Polaris dials it. Usually the server's own address; for a relay on a
     * machine whose high ports nobody forwards, a loopback address that tunnels
     * through the SSH connection Polaris already has to it.
     */
    readonly baseUrl: string;
    /**
     * How something ON that machine dials it. The vision worker runs beside the
     * relay, so it must be given the real address rather than a tunnel that only
     * exists inside the Polaris process.
     */
    readonly directUrl: string;
    readonly username: string;
    readonly password: string;
}

/** Where a camera's connection is made from: "local", or the id of the server
 *  that can see it. Read off the camera's own `reachVia`. */
export function relayServerFor(reachVia: string): string {
    return reachVia.startsWith("server:") ? reachVia.slice("server:".length) : "local";
}

/** The name a camera's stream has inside the relay. Derived from the id rather
 *  than the name so renaming a camera does not orphan its stream. */
export function streamName(cameraId: string, quality: "main" | "sub"): string {
    return `${cameraId}-${quality}`;
}

/** The relay installed on one server, or null when that server has none. */
async function findRelay(serverId: string): Promise<{ installedAppId: string; applicationId: string; ownerId: string } | null> {
    const targetId = await targetIdFor(serverId);
    const row = await prisma.installedApp.findFirst({
        where: {
            catalogId: RELAY_APP,
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

/** The deploy target a server id resolves to, when one already exists. Null for
 *  a server that has never had anything deployed on it, which is also the case
 *  where no relay can be found. */
async function targetIdFor(serverId: string): Promise<string | null> {
    if (serverId === "local") {
        const local = await prisma.deployTarget.findFirst({ where: { kind: "local" }, select: { id: true } });
        return local?.id ?? null;
    }
    const target = await prisma.deployTarget.findFirst({ where: { hostId: serverId }, select: { id: true } });
    return target?.id ?? null;
}

/**
 * The two addresses a relay answers on: the one Polaris uses and the one its own
 * machine uses.
 *
 * The direct address is how every other deployed app is dialled - the server's
 * address and the app's stable host port. It works whenever Polaris and the
 * server are on speaking terms, which is the ordinary case and the fast one.
 *
 * When it does not answer, the relay is on a machine Polaris can only reach
 * through SSH: a second router, a guest network, another building. Rather than
 * asking somebody to forward another port, the stream comes back down that SSH
 * connection. Which of the two is in use is decided by knocking once and
 * remembering the answer, so it costs nothing per request.
 */
async function urlsFor(
    applicationId: string,
    ownerId: string
): Promise<{ baseUrl: string; directUrl: string } | null> {
    const application = await prisma.application.findFirst({
        where: { id: applicationId },
        select: { target: { select: { kind: true, hostId: true, host: { select: { address: true } } } } }
    });
    if (!application) return null;
    const local = application.target.kind === "local";
    const dialHost = local ? await getPublicIp() : (application.target.host?.address?.trim() ?? null);
    if (!dialHost) return null;

    const port = hostPortForApp(applicationId);
    const directUrl = `http://${dialHost}:${port}`;
    const hostId = application.target.hostId;
    if (local || !hostId) return { baseUrl: directUrl, directUrl };

    if (await reachable(dialHost, port)) return { baseUrl: directUrl, directUrl };
    // A tunnel that cannot be opened is not a reason to answer nothing: the
    // direct address is still the best guess, and the caller's own failure says
    // more than a silent null would.
    const tunnelled = await tunnelledUrl(hostId, ownerId, "127.0.0.1", port).catch(() => null);
    return { baseUrl: tunnelled ?? directUrl, directUrl };
}

/** Whether a port answers, remembered for a while.
 *
 *  Asked once per relay rather than per request: the answer is a fact about the
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

/** The account the relay was installed with, read back from the app's own
 *  environment - see install-secret for why it is not kept twice. */
async function relayCredentials(applicationId: string, ownerId: string): Promise<{ username: string; password: string } | null> {
    const [username, password] = await Promise.all([
        installEnvValue(applicationId, ownerId, "RELAY_USERNAME", "polaris"),
        installEnvSecret(applicationId, ownerId, "RELAY_PASSWORD")
    ]);
    return password ? { username, password } : null;
}

/** The relay serving one server, or null when there is not one yet. */
export async function relayEndpoint(serverId: string): Promise<RelayEndpoint | null> {
    const relay = await findRelay(serverId);
    if (!relay) return null;
    const [urls, auth] = await Promise.all([
        urlsFor(relay.applicationId, relay.ownerId),
        relayCredentials(relay.applicationId, relay.ownerId)
    ]);
    if (!urls || !auth) return null;
    return { installedAppId: relay.installedAppId, ...urls, ...auth };
}

/**
 * The relay serving one server, installing it if this is the first camera there.
 *
 * Installing is a deploy, so this is slow the first time and instant every time
 * after. Callers that are rendering must not use it - the wall asks
 * `relayEndpoint` and shows a camera as "starting" instead of holding the page
 * open on a container pull.
 */
export async function ensureRelay(ownerId: string, actorId: string, serverId: string): Promise<RelayEndpoint> {
    const existing = await relayEndpoint(serverId);
    if (existing) return existing;

    // A server id that names nothing is not something to install onto.
    if (serverId !== "local") {
        const hosts = await listHosts(ownerId);
        if (!hosts.some((host) => host.id === serverId)) throw new Error("That server is not connected");
    }
    await installApp(ownerId, actorId, {
        catalogId: RELAY_APP,
        name: "Camera relay",
        serverId,
        storage: [],
        env: []
    });
    const endpoint = await relayEndpoint(serverId);
    if (!endpoint) throw new Error("The camera relay was installed but is not answering yet");
    return endpoint;
}

function authHeader(endpoint: RelayEndpoint): string {
    return `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}`;
}

/** One call to a relay. Short timeout: everything here happens while somebody is
 *  waiting, and a relay that is not answering should say so rather than hold a
 *  page open. */
async function relayFetch(
    endpoint: RelayEndpoint,
    path: string,
    init: { method?: string; timeoutMs?: number; headers?: Record<string, string>; body?: string } = {}
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 5000);
    try {
        return await fetch(`${endpoint.baseUrl}${path}`, {
            method: init.method ?? "GET",
            headers: { authorization: authHeader(endpoint), ...(init.headers ?? {}) },
            ...(init.body === undefined ? {} : { body: init.body }),
            signal: controller.signal,
            redirect: "manual"
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Tell the relay about a camera: the good stream and the small one, under names
 * derived from its id.
 *
 * Setting a stream does not connect to the camera. go2rtc dials a source when
 * something asks to consume it and drops it when the last consumer leaves, which
 * is the behavior that makes "added but never opened" cost nothing.
 */
export async function publishCamera(endpoint: RelayEndpoint, camera: CameraTarget, vendor: string): Promise<void> {
    const auth = { username: camera.username, password: camera.password };
    const shape = {
        vendor,
        address: camera.address,
        rtspPort: camera.rtspPort,
        mainPath: mainPathOf(camera),
        subPath: subPathOf(camera)
    };
    for (const quality of ["main", "sub"] as const) {
        const source = relaySource(shape, quality, auth);
        const query = new URLSearchParams({ name: streamName(camera.id, quality), src: source });
        const response = await relayFetch(endpoint, `/api/streams?${query.toString()}`, { method: "PUT" });
        // The relay validates the source and refuses one it cannot parse. Its
        // reason is about a URL that carries a password, so it is not passed on.
        if (!response.ok) throw new Error("The relay would not accept that camera");
    }
}

/** Stop serving a camera, both qualities. Best effort: a relay that has already
 *  forgotten it is the state we were asking for. */
export async function unpublishCamera(endpoint: RelayEndpoint, cameraId: string): Promise<void> {
    for (const quality of ["main", "sub"] as const) {
        await relayFetch(endpoint, `/api/streams?src=${encodeURIComponent(streamName(cameraId, quality))}`, {
            method: "DELETE"
        }).catch(() => null);
    }
}

/** Which streams a relay currently holds. Used to reconcile after a restart, and
 *  to tell "not published yet" from "published and the camera is down". */
export async function publishedStreams(endpoint: RelayEndpoint): Promise<string[]> {
    const response = await relayFetch(endpoint, "/api/streams", { timeoutMs: 3000 }).catch(() => null);
    if (!response?.ok) return [];
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return body ? Object.keys(body) : [];
}

/**
 * A still from a camera, as JPEG bytes.
 *
 * This is what the wall shows before anybody presses play, and what an event
 * keeps as its picture. It goes through the relay rather than the camera for the
 * usual reason: the camera has one connection to give and the relay already has
 * it.
 */
export async function snapshot(endpoint: RelayEndpoint, cameraId: string, quality: "main" | "sub" = "sub"): Promise<Buffer | null> {
    const response = await relayFetch(
        endpoint,
        `/api/frame.jpeg?src=${encodeURIComponent(streamName(cameraId, quality))}`,
        // A camera that is asleep takes a moment to produce its first frame.
        { timeoutMs: 8000 }
    ).catch(() => null);
    if (!response?.ok) return null;
    return Buffer.from(await response.arrayBuffer());
}

/** Where a viewer's player connects, as a path on the relay. The browser never
 *  sees this - it is what the authenticated proxy route dials. */
export function streamPath(cameraId: string, kind: "mp4" | "hls" | "webrtc" | "ws", quality: "main" | "sub" = "main"): string {
    const src = encodeURIComponent(streamName(cameraId, quality));
    if (kind === "mp4") return `/api/stream.mp4?src=${src}`;
    if (kind === "hls") return `/api/stream.m3u8?src=${src}`;
    if (kind === "webrtc") return `/api/webrtc?src=${src}`;
    return `/api/ws?src=${src}`;
}

/** Dial a relay path and hand back the raw response, for the proxy route that
 *  streams it on to a viewer. */
export async function relayStream(endpoint: RelayEndpoint, path: string, init?: { method?: string; body?: string; contentType?: string }): Promise<Response> {
    return relayFetch(endpoint, path, {
        method: init?.method ?? "GET",
        // Video is a long read; the timeout is on getting the response started,
        // and the body streams for as long as somebody is watching.
        timeoutMs: 10_000,
        ...(init?.contentType ? { headers: { "content-type": init.contentType } } : {}),
        ...(init?.body === undefined ? {} : { body: init.body })
    });
}

/** The camera's own main path, recovered from the URL the target carries. The
 *  target holds full URLs because that is what everything else needs; the relay
 *  wants the pieces so it can build a source of its own kind. */
function mainPathOf(camera: CameraTarget): string {
    return pathOf(camera.mainUrl);
}

function subPathOf(camera: CameraTarget): string {
    return pathOf(camera.subUrl);
}

function pathOf(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.pathname}${parsed.search}`;
    } catch {
        return "";
    }
}
