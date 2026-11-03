/**
 * The Matter bridge: the controller a Matter camera joins, one per server, next
 * to that server's camera relay.
 *
 * Installed on demand like the relay - the first Matter camera brings it up on
 * the machine that camera is reached from - and dialled the same way. Polaris
 * asks it to add a camera with the code the camera's own app shares, and the
 * relay watches the camera through it, so the camera holds one WebRTC session
 * however many people watch.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";
import { streamPathOf } from "./stream-path";
import { relayServerFor } from "./relay";
import type { CameraTarget } from "./cameras";
import { host } from "@polaris/app-host";
import {
    matterRelaySource,
    matterStreamPath,
    normalizeMatterCode,
    parseMatterPath
} from "./matter-code";
import { assertServer, findService, serviceUrls, type ServiceUrls } from "./side-service";

const { installApp } = host.appsInstallService;
const { installEnvSecret, installEnvValue } = host.appsInstallSecret;

const BRIDGE_APP = "matter-bridge";

export interface BridgeEndpoint extends ServiceUrls {
    readonly username: string;
    readonly password: string;
}

export async function matterBridge(serverId: string): Promise<BridgeEndpoint | null> {
    const bridge = await findService(BRIDGE_APP, serverId);
    if (!bridge) return null;
    const [urls, username, password] = await Promise.all([
        serviceUrls(bridge.applicationId, bridge.ownerId),
        installEnvValue(bridge.applicationId, bridge.ownerId, "BRIDGE_USERNAME", "polaris"),
        installEnvSecret(bridge.applicationId, bridge.ownerId, "BRIDGE_PASSWORD")
    ]);
    if (!urls || !password) return null;
    return { ...urls, username, password };
}

/** The bridge on one server, installed if this is its first Matter camera. */
export async function ensureMatterBridge(
    ownerId: string,
    actorId: string,
    serverId: string
): Promise<BridgeEndpoint> {
    const existing = await matterBridge(serverId);
    if (existing) return existing;
    await assertServer(ownerId, serverId);
    await installApp(ownerId, actorId, {
        catalogId: BRIDGE_APP,
        name: "Matter bridge",
        serverId,
        storage: [],
        env: []
    });
    const endpoint = await matterBridge(serverId);
    if (!endpoint) throw new HomeError("The Matter bridge was installed but is not answering yet");
    return endpoint;
}

async function bridgeFetch(
    endpoint: BridgeEndpoint,
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<Response | null> {
    const auth = Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64");
    return fetch(`${endpoint.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
            authorization: `Basic ${auth}`,
            ...(init.body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(init.timeoutMs ?? 5000),
        redirect: "manual"
    }).catch(() => null);
}

/** The bridge's reason for a camera it could not add, as a sentence for the
 *  person who typed the code. Exported for its test. */
export function commissionSentence(reason: unknown): string {
    switch (reason) {
        case "invalid-payload":
            return "That pairing code is not one a Matter camera gives";
        case "passcode-mismatch":
            return "The camera refused that pairing code. Share it again from the camera's app";
        case "not-discovered":
        case "timeout":
            return "The camera did not answer. Share it again from its app and add it within a few minutes";
        case "attestation-rejected":
            return "The camera could not prove it is a certified Matter device";
        case "not-a-camera":
            return "That pairing code belongs to a Matter device that is not a camera";
        default:
            return "The camera could not be added. Share it again from its app and try once more";
    }
}

/** Add a camera to the bridge's fabric; answers the path the relay watches it
 *  at. Slow: the camera is found and joined while this waits. */
export async function commissionMatter(
    endpoint: BridgeEndpoint,
    code: string,
    address: string
): Promise<string> {
    const response = await bridgeFetch(endpoint, "/commission", {
        method: "POST",
        body: { code: normalizeMatterCode(code), address },
        timeoutMs: 200_000
    });
    if (!response) throw new HomeError("The Matter bridge is still starting");
    const body = (await response.json().catch(() => ({}))) as {
        nodeId?: unknown;
        endpointId?: unknown;
        error?: unknown;
    };
    if (!response.ok || typeof body.nodeId !== "number" || typeof body.endpointId !== "number")
        throw new HomeError(commissionSentence(body.error));
    return matterStreamPath(body.nodeId, body.endpointId);
}

/** Whether the camera states it can play audio. False when it cannot be asked. */
export async function matterCanTalk(endpoint: BridgeEndpoint, path: string): Promise<boolean> {
    const response = await bridgeFetch(endpoint, `${path}/capabilities`);
    if (!response?.ok) return false;
    const body = (await response.json().catch(() => ({}))) as { talk?: unknown };
    return body.talk === true;
}

/** Take a removed camera off the fabric. Best effort: a bridge that is gone has
 *  no fabric left to hold it. */
export async function forgetMatter(endpoint: BridgeEndpoint, path: string): Promise<void> {
    await bridgeFetch(endpoint, path, { method: "DELETE", timeoutMs: 15_000 });
}

/**
 * Add a Matter camera to the bridge on its machine, once. The pairing code is
 * kept where every make keeps its password (encrypted), and the camera's main
 * path becomes where the bridge keeps it. A camera already added is left alone.
 */
export async function addMatterCamera(
    installedAppId: string,
    ownerId: string,
    actorId: string,
    target: CameraTarget
): Promise<void> {
    if (parseMatterPath(streamPathOf(target.mainUrl))) return;
    const running = adding.get(target.id);
    if (running) return running;
    const attempt = commissionOnce(installedAppId, ownerId, actorId, target).finally(() =>
        adding.delete(target.id)
    );
    adding.set(target.id, attempt);
    return attempt;
}

/** The camera being added right now, by id: a pairing window takes one
 *  commission, so a second start waits on the first instead of racing it. */
const adding = new Map<string, Promise<void>>();

async function commissionOnce(
    installedAppId: string,
    ownerId: string,
    actorId: string,
    target: CameraTarget
): Promise<void> {
    if (!target.password) throw new HomeError("Type the pairing code the camera's app shared");
    const bridge = await ensureMatterBridge(ownerId, actorId, relayServerFor(target.reachVia));
    const path = await commissionMatter(bridge, target.password, target.address);
    await prisma.camera.updateMany({
        where: { id: target.id, installedAppId },
        data: { mainPath: path, subPath: null }
    });
}

/** The relay's source for this camera. The relay runs beside the bridge, so it
 *  dials the bridge's container on their shared network when there is one. */
export function relaySourceFor(endpoint: BridgeEndpoint, path: string): string {
    return matterRelaySource(endpoint.networkUrl ?? endpoint.directUrl, path, endpoint.password);
}
