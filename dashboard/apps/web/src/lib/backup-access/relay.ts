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
 * wireproxy forwards TCP only on the receiving end, so UDP rides inside the same
 * link the way frp carries it for self-hosted game servers: frps on the relay end
 * listens on loopback only, frpc at the house dials it through the WireGuard link,
 * and each UDP port is one frp UDP proxy. Both join their end's namespace, so they
 * need nothing the WireGuard containers do not, and they only run while there is
 * a UDP port to carry.
 */

import { createHmac } from "node:crypto";
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
/**
 * frp, pinned to v0.71.0 (2026-08-14), the images the project publishes itself.
 * Alpine with the binary as entrypoint, so the command is its arguments.
 */
export const FRPS_IMAGE = "fatedier/frps:v0.71.0";
export const FRPC_IMAGE = "fatedier/frpc:v0.71.0";
/** Where frp's two halves meet: TCP on loopback at each end, joined by the link.
 *  The relay's own port number, which no carried port is given, so this listener
 *  never meets one. */
export const FRP_CONTROL_PORT = RELAY_LISTEN_PORT;
/** The frp config's name beside the WireGuard one in the shared volume. */
const FRP_FILE = "frp.toml";
/** The house end reaches this machine's published ports through the gateway. */
const HOST_ALIAS = "host.docker.internal";
/** The same entry `@polaris/deploy` gives what it starts (its `HOST_GATEWAY`). */
const HOST_GATEWAY = `${HOST_ALIAS}:host-gateway`;

export interface RelayPort {
    readonly port: number;
    readonly protocol: "tcp" | "udp";
}

/** The ports the relay carries, by protocol. Sorted, unique. */
export interface RelayPortSet {
    readonly tcp: number[];
    readonly udp: number[];
}

/** The ports the relay carries: the web ports and every game port, TCP and UDP. */
export function relayPorts(gamePorts: readonly RelayPort[]): RelayPortSet {
    const tcp = new Set<number>(WEB_PORTS);
    const udp = new Set<number>();
    for (const entry of gamePorts) {
        if (!isPort(entry.port)) continue;
        // The link's own UDP port, and frp's TCP one.
        if (entry.port === RELAY_LISTEN_PORT) continue;
        (entry.protocol === "udp" ? udp : tcp).add(entry.port);
    }
    return {
        tcp: [...tcp].sort((a, b) => a - b),
        udp: [...udp].sort((a, b) => a - b)
    };
}

function isPort(value: number): boolean {
    return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A port list written into a config: refused whole if one entry is not a port
 *  the relay can carry. */
function carriable(list: readonly number[]): readonly number[] {
    for (const port of list)
        if (!isPort(port) || port === RELAY_LISTEN_PORT)
            throw new Error(`The relay cannot carry port ${port}`);
    return list;
}

export interface RelayKeys {
    /** The relay end's key pair and the house end's. */
    readonly relay: wg.KeyPair;
    readonly home: wg.KeyPair;
}

/** The relay end: listens for the house, forwards each public TCP port into the
 *  link, and lets the house's frpc reach frps when there is UDP to carry. */
export function renderRelayConfig(keys: RelayKeys, carried: RelayPortSet): string {
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
        ...carriable(carried.tcp).flatMap((port) => [
            "[TCPClientTunnel]",
            `BindAddress = 0.0.0.0:${port}`,
            `Target = ${peerAddress}:${port}`,
            ""
        ]),
        ...(carriable(carried.udp).length > 0
            ? [
                  "[TCPServerTunnel]",
                  `ListenPort = ${FRP_CONTROL_PORT}`,
                  `Target = 127.0.0.1:${FRP_CONTROL_PORT}`,
                  ""
              ]
            : [])
    ].join("\n");
}

/** The house end: dials the relay, keeps the mapping open, hands each TCP port to
 *  the same port on this machine, and gives frpc its way to frps. */
export function renderHomeConfig(
    keys: RelayKeys,
    relayAddress: string,
    carried: RelayPortSet
): string {
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
        ...carriable(carried.tcp).flatMap((port) => [
            "[TCPServerTunnel]",
            `ListenPort = ${port}`,
            `Target = ${HOST_ALIAS}:${port}`,
            ""
        ]),
        ...(carriable(carried.udp).length > 0
            ? [
                  "[TCPClientTunnel]",
                  `BindAddress = 127.0.0.1:${FRP_CONTROL_PORT}`,
                  `Target = ${publicAddress}:${FRP_CONTROL_PORT}`,
                  ""
              ]
            : [])
    ].join("\n");
}

/** The secret frpc logs in to frps with. frps is only reachable through the link
 *  already, so this is a second lock; derived from the house's key, so nothing new
 *  is stored and both ends always agree. */
export function frpToken(keys: RelayKeys): string {
    return createHmac("sha256", key(keys.home.privateKey))
        .update("polaris-backup-relay-frp")
        .digest("hex");
}

/** frps on the relay end: its control port on loopback only, each UDP port
 *  listening publicly, and no other port allowed. */
export function renderRelayFrp(keys: RelayKeys, udp: readonly number[]): string {
    const allowed = carriable(udp).map((port) => `{ single = ${port} }`);
    return [
        'bindAddr = "127.0.0.1"',
        `bindPort = ${FRP_CONTROL_PORT}`,
        // Defaults to bindAddr, which would keep every proxy on loopback.
        'proxyBindAddr = "0.0.0.0"',
        'auth.method = "token"',
        `auth.token = "${frpToken(keys)}"`,
        `allowPorts = [${allowed.join(", ")}]`,
        'log.to = "console"',
        'log.level = "warn"',
        ""
    ].join("\n");
}

/** frpc at the house: dials frps through the link, keeps trying until the link is
 *  up, and hands each UDP port to the same port on this machine. */
export function renderHomeFrp(keys: RelayKeys, udp: readonly number[]): string {
    return [
        'serverAddr = "127.0.0.1"',
        `serverPort = ${FRP_CONTROL_PORT}`,
        // The link can come up after frpc does; it logs in again until it does.
        "loginFailExit = false",
        'auth.method = "token"',
        `auth.token = "${frpToken(keys)}"`,
        'log.to = "console"',
        'log.level = "warn"',
        "",
        ...carriable(udp).flatMap((port) => [
            "[[proxies]]",
            `name = "udp-${port}"`,
            'type = "udp"',
            `localIP = "${HOST_ALIAS}"`,
            `localPort = ${port}`,
            `remotePort = ${port}`,
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

export interface RelayEndConfig {
    readonly wireguard: string;
    /** frps' or frpc's config; null when there is no UDP port to carry. */
    readonly frp: string | null;
}

/** Both ends' files for one set of ports. */
export function relayConfigs(
    keys: RelayKeys,
    relayAddress: string,
    carried: RelayPortSet
): { relay: RelayEndConfig; home: RelayEndConfig } {
    const udp = carried.udp.length > 0;
    return {
        relay: {
            wireguard: renderRelayConfig(keys, carried),
            frp: udp ? renderRelayFrp(keys, carried.udp) : null
        },
        home: {
            wireguard: renderHomeConfig(keys, relayAddress, carried),
            frp: udp ? renderHomeFrp(keys, carried.udp) : null
        }
    };
}

/**
 * The containers of one end: the WireGuard tunnels' own two-container shape, with
 * the relay end publishing every carried port and the house end able to reach
 * this machine's published ports, plus frp in the same namespace when there is
 * UDP to carry.
 */
export function relaySpec(
    end: "relay" | "home",
    config: RelayEndConfig,
    carried: RelayPortSet
): ComposeSpec {
    const spec = wg.endSpec({
        tunnelId: RELAY_ID,
        end: end === "relay" ? "public" : "nat",
        config: config.wireguard,
        networks: [],
        listenPort: end === "relay" ? RELAY_LISTEN_PORT : undefined,
        extraFiles: config.frp ? [{ name: FRP_FILE, content: config.frp }] : []
    });
    const [helper, ...rest] = spec.services;
    if (!helper) throw new Error("A WireGuard end has no helper container");
    const published = (protocol: "tcp" | "udp") => (port: number) => ({
        host: port,
        container: port,
        protocol
    });
    const frp: ComposeSpec["services"] = config.frp
        ? [
              {
                  name: `${helper.name}-frp`,
                  image: end === "relay" ? FRPS_IMAGE : FRPC_IMAGE,
                  pullPolicy: "missing",
                  env: {},
                  ports: [],
                  volumes: helper.volumes,
                  labels: {},
                  command: ["-c", `/etc/wireproxy/${FRP_FILE}`],
                  networks: [],
                  networkMode: `service:${helper.name}`,
                  dependsOn: [helper.name],
                  // The first start can beat the helper's write; it simply starts again.
                  restart: "unless-stopped"
              }
          ]
        : [];
    return {
        ...spec,
        services: [
            {
                ...helper,
                ports:
                    end === "relay"
                        ? [
                              ...helper.ports,
                              ...carriable(carried.tcp).map(published("tcp")),
                              ...(config.frp ? carriable(carried.udp).map(published("udp")) : [])
                          ]
                        : helper.ports,
                extraHosts: end === "home" ? [HOST_GATEWAY] : helper.extraHosts
            },
            ...rest,
            ...frp
        ]
    };
}

/** The compose project of one end, for taking it down. */
export function relayProject(end: "relay" | "home"): string {
    return wg.endNames(RELAY_ID, end === "relay" ? "public" : "nat").project;
}
