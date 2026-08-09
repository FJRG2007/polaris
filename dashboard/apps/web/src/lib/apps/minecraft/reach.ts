/**
 * Whether a game server can be reached from outside, and proving that it is.
 *
 * Two things are needed and only one of them is Polaris's: the port has to reach
 * this machine, and Polaris has to know that it does. The second is the awkward
 * half. A probe from this box leaves and comes back through the operator's own
 * router, and plenty of them will not route their public address back inward, so a
 * silent probe proves nothing. It is therefore only ever used as positive evidence,
 * and the other proof needs nothing at all: a player who joined from a public
 * address is a packet that arrived, and no router can fake that.
 *
 * What the operator is told once this has decided is `reach-advice.ts`, which is
 * pure and can be rendered in the browser; everything here is sockets and rows.
 */

import { connect } from "node:net";
import { prisma } from "@polaris/db";
import { pingBedrock } from "@/lib/apps/minecraft/raknet";
import { isCarrierGradeNat, isPublicIpv4 } from "@polaris/core";
import { getHostLanIp, isLanAddress } from "@/lib/host-address";
import { getPortBlocks, getPortPolicy } from "@/lib/apps/port-block-store";
import { detectPublicIp, getLocalEnvironment } from "@/lib/network-service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { gameReachAdvice, type GamePort, type GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";

/** The ports a game install actually publishes, from what its deploy pinned. */
export async function gamePorts(applicationId: string | null): Promise<GamePort[]> {
    if (!applicationId) return [];
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { sourceConfig: true } });
    if (!app) return [];
    let config: {
        hostPort?: unknown;
        hostProtocol?: unknown;
        extraPorts?: unknown;
    };
    try {
        config = JSON.parse(app.sourceConfig) as typeof config;
    } catch {
        return [];
    }
    const ports: GamePort[] = [];
    if (typeof config.hostPort === "number") {
        ports.push({ port: config.hostPort, protocol: config.hostProtocol === "udp" ? "udp" : "tcp" });
    }
    if (Array.isArray(config.extraPorts)) {
        for (const entry of config.extraPorts) {
            const extra = entry as { host?: unknown; protocol?: unknown };
            if (typeof extra.host === "number") {
                ports.push({ port: extra.host, protocol: extra.protocol === "udp" ? "udp" : "tcp" });
            }
        }
    }
    return ports;
}

/** Whether this install has ever been seen answering from outside. */
export function reachConfirmed(config: string | null | undefined): boolean {
    return typeof readInstallConfig(config).portReachableAt === "string";
}

/**
 * Record that the port demonstrably works, from a player who arrived on it.
 *
 * Only a public address counts. A join from the same LAN went nowhere near the
 * router, so treating it as proof would clear the warning for exactly the operator
 * who tested from their own desk - the one case where it means nothing.
 */
export async function noteReachedFrom(installedAppId: string, address: string): Promise<boolean> {
    if (isLanAddress(address)) return false;
    await patchInstallConfig(installedAppId, { portReachableAt: new Date().toISOString() });
    return true;
}

/** How long to wait on a port before calling the probe inconclusive. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Try to open the port from here, through the public address.
 *
 * Positive evidence only: a connection that completes went out to the public
 * address and came back in, which is the forward working. A refusal or a timeout
 * is reported as false and means nothing on its own - most routers do not loop
 * their own WAN address back inward. This one speaks TCP; a UDP port is asked the
 * only question it can answer, in `raknet.ts`.
 */
export function probeGamePort(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port, timeout: timeoutMs });
        const settle = (reached: boolean): void => {
            socket.destroy();
            resolve(reached);
        };
        socket.once("connect", () => settle(true));
        socket.once("timeout", () => settle(false));
        socket.once("error", () => settle(false));
    });
}

/** A local connect crosses no router, so it either answers at once or there is
 *  nothing there. Short enough that a page can wait for it. */
const LOCAL_PROBE_TIMEOUT_MS = 700;

/**
 * Whether anything is listening on these ports here, on this network.
 *
 * The question the reach advice was missing. A server that is still generating
 * its world answers nothing, from inside or out, and reading that silence as "the
 * router is not forwarding it" is what told an operator to open a port they had
 * already opened - and then ticked it by itself once the server finished booting.
 *
 * Null when there is no address to try, so the advice can say nothing about it
 * rather than infer. A UDP port can only ever answer yes here: a Bedrock server
 * replies to a RakNet ping, but a UDP game that speaks anything else is silent
 * whether it is up or down, and reading that silence as "down" would be the same
 * mistake in the other direction.
 */
export async function probeListening(ports: readonly GamePort[], lanIp: string | null): Promise<boolean | null> {
    const host = lanIp ?? "127.0.0.1";
    for (const port of ports.filter((entry) => entry.protocol === "udp")) {
        if (await pingBedrock(host, port.port, LOCAL_PROBE_TIMEOUT_MS)) return true;
    }
    const tcp = ports.filter((entry) => entry.protocol === "tcp");
    if (tcp.length === 0) return null;
    for (const port of tcp) {
        if (await probeGamePort(host, port.port, LOCAL_PROBE_TIMEOUT_MS)) return true;
    }
    return false;
}

/** How long a probe's answer stands before the port is worth knocking on again.
 *  A forward is created once and then left alone, and every open panel polls, so
 *  the cheap thing is to let one attempt cover them all. */
const PROBE_EVERY_MS = 30_000;

/** When each install was last knocked on, so a page left open does not knock on
 *  every poll and two open pages do not double it. Per process, deliberately: it
 *  is a rate limit, not a record - what is proven is written to the install. */
const probedAt = new Map<string, number>();

/** A server whose port is not proven yet, as the probe needs it. */
export interface PendingReach {
    readonly installedAppId: string;
    readonly ports: readonly GamePort[];
}

/**
 * Knock on the ports that are not proven yet, and record the ones that answer.
 *
 * This is the half that lets a panel notice a forward that has just been made,
 * rather than waiting for a player to arrive: the packet still has to leave this
 * network and come back through the router, so a connection that completes is the
 * forward working. Nothing is concluded from silence - see `probeGamePort` - and
 * nothing is attempted at all unless this line has an address the internet could
 * dial, since knocking on a LAN address would clear the warning for the one
 * operator whose forward does not exist.
 *
 * Returns the installs proven by this pass.
 */
export async function probeReach(pending: readonly PendingReach[]): Promise<string[]> {
    if (pending.length === 0) return [];
    const host = await probeHost();
    if (!host) return [];
    const reached: string[] = [];
    for (const entry of pending) {
        const last = probedAt.get(entry.installedAppId) ?? 0;
        if (Date.now() - last < PROBE_EVERY_MS) continue;
        probedAt.set(entry.installedAppId, Date.now());
        for (const port of entry.ports) {
            // A UDP port is asked in RakNet, which is the one thing a Bedrock
            // server will answer - without it a Bedrock server could never be
            // proven at all, since its log prints no player address either.
            const answered =
                port.protocol === "tcp"
                    ? await probeGamePort(host, port.port)
                    : await pingBedrock(host, port.port, PROBE_TIMEOUT_MS);
            if (!answered) continue;
            if (await noteReachedFrom(entry.installedAppId, host)) reached.push(entry.installedAppId);
            break;
        }
    }
    return reached;
}

/** The address to knock on: what this network reaches the internet from, and only
 *  when it is one an outside client could use. A carrier-NAT address is shared
 *  with other customers, so what answers on it need not be this machine at all. */
async function probeHost(): Promise<string | null> {
    const ip = await detectPublicIp().catch(() => null);
    if (!ip || !isPublicIpv4(ip) || isCarrierGradeNat(ip)) return null;
    return ip;
}

/**
 * What is still in the way for one install, gathered from everything it depends
 * on. Shared by the page that renders the panel and the endpoint it polls, so the
 * advice cannot say two different things depending on which asked.
 *
 * `probe` is off for a render and on for a poll: knocking on a port costs seconds
 * against a router that drops the packet, and a page must not wait on it to paint.
 */
export async function reachAdviceFor(installedAppId: string, probe = false): Promise<GameReachAdvice> {
    const install = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { applicationId: true, config: true }
    });
    const [{ environment }, lanIp, ports, policy, blocks] = await Promise.all([
        getLocalEnvironment().catch(() => ({ environment: "unknown" as const })),
        getHostLanIp().catch(() => null),
        gamePorts(install?.applicationId ?? null),
        getPortPolicy(),
        getPortBlocks()
    ]);
    let confirmed = reachConfirmed(install?.config);
    if (!confirmed && probe) {
        confirmed = (await probeReach([{ installedAppId, ports }])).length > 0;
    }
    // Only asked when it would change what is said. A server already proven from
    // outside is reachable whatever it is doing right now, and a local connect on
    // every render would be a page waiting on a socket for nothing.
    const listening = confirmed ? null : await probeListening(ports, lanIp).catch(() => null);
    return gameReachAdvice(environment, ports, confirmed, lanIp, policy, blocks, listening);
}
