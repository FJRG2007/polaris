/**
 * The own-relay path, the pure half: the two WireGuard ends' config files and
 * the containers that run them.
 *
 * Same shape as the self-hosted relays that settled this (a WireGuard endpoint on
 * a cloud server forwarding the public ports into a link the house dials out on),
 * built from the pieces Polaris' WireGuard tunnels already run: userspace
 * WireGuard (wireproxy), so neither end needs NET_ADMIN, a TUN device or a kernel
 * module, and both fit the shapes the host daemon allows.
 *
 * The relay end publishes 80, 443 and the game ports and forwards each one through
 * the link; the house end dials the relay with a keepalive and hands each port to
 * this machine's own published port, so Traefik and the game servers answer as
 * they do on the direct path.
 *
 * wireproxy forwards TCP only on the receiving end (its UDP tunnel only listens
 * locally), so UDP game ports are not carried: `relayPorts` drops them and says
 * which, and the screen tells the operator.
 */

import type { ComposeSpec } from "@polaris/deploy";
import * as wg from "@/lib/deploy/wireguard/tunnel-config";

/** The UDP port the relay listens on: one past the range WireGuard tunnels hand
 *  out, so the two never ask a server for the same port. */
export const RELAY_LISTEN_PORT = wg.LAST_LISTEN_PORT + 1;
/** The link's addresses. Each end runs in its own network namespace, so the slot
 *  never meets a tunnel's. */
export const RELAY_SLOT = 16383;
/** The web ports every relay carries. */
export const WEB_PORTS = [80, 443] as const;
/** The house end reaches this machine's published ports through the gateway. */
const HOST_ALIAS = "host.docker.internal";
/** The same entry `@polaris/deploy` gives what it starts (its `HOST_GATEWAY`). */
const HOST_GATEWAY = `${HOST_ALIAS}:host-gateway`;

export interface RelayPort {
    readonly port: number;
    readonly protocol: "tcp" | "udp";
}

/** The ports the relay carries, and the UDP ones it cannot. Sorted, unique. */
export function relayPorts(gamePorts: readonly RelayPort[]): {
    tcp: number[];
    skippedUdp: number[];
} {
    const tcp = new Set<number>(WEB_PORTS);
    const udp = new Set<number>();
    for (const entry of gamePorts) {
        if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) continue;
        if (entry.port === RELAY_LISTEN_PORT) continue;
        (entry.protocol === "udp" ? udp : tcp).add(entry.port);
    }
    return {
        tcp: [...tcp].sort((a, b) => a - b),
        skippedUdp: [...udp].filter((port) => !tcp.has(port)).sort((a, b) => a - b)
    };
}

export interface RelayKeys {
    /** The relay end's key pair and the house end's. */
    readonly relay: wg.KeyPair;
    readonly home: wg.KeyPair;
}

/** The relay end: listens for the house, and forwards each public port into the link. */
export function renderRelayConfig(keys: RelayKeys, ports: readonly number[]): string {
    const { publicAddress, peerAddress } = wg.slotAddresses(RELAY_SLOT);
    return [
        "[Interface]",
        `PrivateKey = ${key(keys.relay.privateKey)}`,
        `Address = ${publicAddress}/32`,
        `ListenPort = ${RELAY_LISTEN_PORT}`,
        "",
        "[Peer]",
        `PublicKey = ${key(keys.home.publicKey)}`,
        `AllowedIPs = ${peerAddress}/32`,
        "",
        ...ports.flatMap((port) => [
            "[TCPClientTunnel]",
            `BindAddress = 0.0.0.0:${port}`,
            `Target = ${peerAddress}:${port}`,
            ""
        ])
    ].join("\n");
}

/** The house end: dials the relay, keeps the mapping open, and hands each port to
 *  the same port on this machine. */
export function renderHomeConfig(keys: RelayKeys, relayAddress: string, ports: readonly number[]): string {
    const { publicAddress, peerAddress } = wg.slotAddresses(RELAY_SLOT);
    const endpoint = `${relayAddress.includes(":") ? `[${relayAddress}]` : relayAddress}:${RELAY_LISTEN_PORT}`;
    if (!wg.isHostPort(endpoint)) throw new Error("The relay's address is not an address");
    return [
        "[Interface]",
        `PrivateKey = ${key(keys.home.privateKey)}`,
        `Address = ${peerAddress}/32`,
        "",
        "[Peer]",
        `PublicKey = ${key(keys.relay.publicKey)}`,
        `Endpoint = ${endpoint}`,
        `AllowedIPs = ${publicAddress}/32`,
        `PersistentKeepalive = ${wg.KEEPALIVE_SECONDS}`,
        "",
        ...ports.flatMap((port) => [
            "[TCPServerTunnel]",
            `ListenPort = ${port}`,
            `Target = ${HOST_ALIAS}:${port}`,
            ""
        ])
    ].join("\n");
}

function key(value: string): string {
    if (!wg.isWireguardKey(value)) throw new Error("A relay key is not a WireGuard key");
    return value;
}

/** A stable id for the compose names, so both ends are found again after a restart. */
export const RELAY_ID = "000000backup";

/**
 * The containers of one end: the WireGuard tunnels' own two-container shape, with
 * the relay end publishing every carried port and the house end able to reach
 * this machine's published ports.
 */
export function relaySpec(end: "relay" | "home", config: string, ports: readonly number[]): ComposeSpec {
    const spec = wg.endSpec({
        tunnelId: RELAY_ID,
        end: end === "relay" ? "public" : "nat",
        config,
        networks: [],
        listenPort: end === "relay" ? RELAY_LISTEN_PORT : undefined
    });
    const [helper, ...rest] = spec.services;
    return {
        ...spec,
        services: [
            {
                ...helper,
                ports:
                    end === "relay"
                        ? [...helper.ports, ...ports.map((port) => ({ host: port, container: port }))]
                        : helper.ports,
                extraHosts: end === "home" ? [HOST_GATEWAY] : helper.extraHosts
            },
            ...rest
        ]
    };
}

/** The compose project of one end, for taking it down. */
export function relayProject(end: "relay" | "home"): string {
    return wg.endNames(RELAY_ID, end === "relay" ? "public" : "nat").project;
}
