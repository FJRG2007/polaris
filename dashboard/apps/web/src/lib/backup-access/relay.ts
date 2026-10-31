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
 * The relay end forwards the game ports it publishes through the link; the house
 * end dials the relay with a keepalive and hands each port to this machine's own
 * published port, so Traefik and the game servers answer as they do on the direct
 * path, except 443, which goes to the edge directly (see `RELAY_EDGE_NETWORK`). The
 * web ports are not published: 80 and 443 belong to the server's own edge, which
 * hands the house's hostnames to the relay and goes on serving everything else, so
 * a server can be a relay and a deploy target at once.
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
/** Raised when both ends must be brought up again with what this build renders. */
export const RELAY_SPEC = 3;
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
/**
 * The network only the house end and this machine's edge share. The edge believes a
 * PROXY header from this network's relay range and from nowhere else, so 443 has to
 * arrive over it: through the published port the house end would be one more Docker
 * gateway, the same one public IPv6 visitors arrive from.
 */
export const RELAY_EDGE_NETWORK = "polaris-relay-edge";
/** The edge on that network, as `docker-compose.yml` pins it. */
export const RELAY_EDGE_ADDRESS = "10.213.254.2";
const TLS_PORT = 443;

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
            `Target = ${port === TLS_PORT ? RELAY_EDGE_ADDRESS : HOST_ALIAS}:${port}`,
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
 *  up, and hands each UDP port to the same port on this machine, at `local`. The
 *  call server binds its UDP port to the LAN address alone, so the gateway reaches
 *  a game's published port but drops every packet of a call. */
export function renderHomeFrp(
    keys: RelayKeys,
    udp: readonly number[],
    local: string = HOST_ALIAS
): string {
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
            `localIP = "${local}"`,
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

/** The file on the relay server's edge that sends the house's hostnames to the relay. */
export const RELAY_ROUTES_FILE = "polaris-relay.yml";
/** Above an app's route on the same edge and the route to its certificate
 *  challenges, so a challenge for a house name reaches the house. */
const RELAY_ROUTE_PRIORITY = 200;

const ROUTABLE_HOST = /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** A hostname as a Traefik matcher. `[.]` rather than an escaped dot, so no layer of
 *  YAML or shell has a backslash to eat. A wildcard covers every depth, as its DNS
 *  record does. */
function hostMatcher(name: string, exact: string, regexp: string): string {
    const host = name.toLowerCase();
    if (!ROUTABLE_HOST.test(host)) throw new Error(`Not a hostname the relay can route: ${name}`);
    if (!host.startsWith("*.")) return `${exact}(\`${host}\`)`;
    return `${regexp}(\`^.+[.]${host.slice(2).replaceAll(".", "[.]")}$\`)`;
}

/** The names under a house wildcard that this server answers itself. A name the
 *  house owns outright stays the house's. */
function ownNames(names: readonly string[], served: readonly string[]): string[] {
    const house = new Set(names.map((name) => name.toLowerCase()));
    const zones = [...house].filter((name) => name.startsWith("*.")).map((name) => name.slice(1));
    const own = served
        .map((name) => name.toLowerCase())
        .filter((name) => ROUTABLE_HOST.test(name) && !house.has(name))
        .filter((name) => zones.some((zone) => name.endsWith(zone)));
    return [...new Set(own)].sort();
}

/**
 * The relay server's edge routes for the house's hostnames.
 *
 * TLS passes through untouched, so the house's edge keeps terminating it with its
 * own certificates, and port 80 is carried so Let's Encrypt can still reach it. Any
 * other hostname falls through to whatever that server serves itself, and so do the
 * `served` names of the apps deployed there, which sit under a house wildcard.
 */
export function renderRelayRoutes(
    names: readonly string[],
    served: readonly string[] = []
): string {
    const upstream = relayHelper();
    const own = ownNames(names, served);
    const rule = (exact: string, regexp: string) => {
        const matches = (list: readonly string[]) =>
            list.map((name) => hostMatcher(name, exact, regexp)).join(" || ");
        return own.length > 0
            ? `'(${matches(names)}) && !(${matches(own)})'`
            : `'${matches(names)}'`;
    };
    return [
        "tcp:",
        "  routers:",
        "    polaris-relay-tls:",
        `      rule: ${rule("HostSNI", "HostSNIRegexp")}`,
        "      entryPoints: [websecure]",
        "      service: polaris-relay-tls",
        `      priority: ${RELAY_ROUTE_PRIORITY}`,
        "      tls:",
        "        passthrough: true",
        "  services:",
        "    polaris-relay-tls:",
        "      loadBalancer:",
        // Each visitor's own address, read by the house's edge: without it they all
        // arrive as one Docker gateway, and one ban or rate limit lands on everyone.
        // This form, because a relay's Traefik can predate the serversTransport one.
        "        proxyProtocol:",
        "          version: 2",
        "        servers:",
        `          - address: "${upstream}:443"`,
        "http:",
        "  routers:",
        "    polaris-relay-web:",
        `      rule: ${rule("Host", "HostRegexp")}`,
        "      entryPoints: [web]",
        "      service: polaris-relay-web",
        `      priority: ${RELAY_ROUTE_PRIORITY}`,
        "  services:",
        "    polaris-relay-web:",
        "      loadBalancer:",
        "        servers:",
        `          - url: "http://${upstream}:80"`,
        ""
    ].join("\n");
}

export interface RelayEndConfig {
    readonly wireguard: string;
    /** frps' or frpc's config; null when there is no UDP port to carry. */
    readonly frp: string | null;
}

/** Both ends' files for one set of ports. */
export function relayConfigs(
    keys: RelayKeys,
    relayAddress: string,
    carried: RelayPortSet,
    lanAddress: string | null = null
): { relay: RelayEndConfig; home: RelayEndConfig } {
    const udp = carried.udp.length > 0;
    return {
        relay: {
            wireguard: renderRelayConfig(keys, carried),
            frp: udp ? renderRelayFrp(keys, carried.udp) : null
        },
        home: {
            wireguard: renderHomeConfig(keys, relayAddress, carried),
            frp: udp ? renderHomeFrp(keys, carried.udp, lanAddress ?? HOST_ALIAS) : null
        }
    };
}

/**
 * The containers of one end: the WireGuard tunnels' own two-container shape, with
 * the relay end publishing every carried port but the web ones, which reach it over
 * `networks` from the server's edge, and the house end able to reach this machine's
 * published ports, plus frp in the same namespace when there is UDP to carry.
 */
export function relaySpec(
    end: "relay" | "home",
    config: RelayEndConfig,
    carried: RelayPortSet,
    networks: string[] = []
): ComposeSpec {
    const spec = wg.endSpec({
        tunnelId: RELAY_ID,
        end: end === "relay" ? "public" : "nat",
        config: config.wireguard,
        networks,
        listenPort: end === "relay" ? RELAY_LISTEN_PORT : undefined,
        extraFiles: config.frp ? [{ name: FRP_FILE, content: config.frp }] : [],
        hostAlias: end === "home" ? HOST_ALIAS : undefined
    });
    const [helper, ...rest] = spec.services;
    if (!helper) throw new Error("A WireGuard end has no helper container");
    const home = end === "home";
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
        networks: home ? [RELAY_EDGE_NETWORK] : spec.networks,
        services: [
            {
                ...helper,
                // `default` is the way out to the relay: the edge's network is internal.
                networks: home ? ["default", RELAY_EDGE_NETWORK] : helper.networks,
                ports:
                    end === "relay"
                        ? [
                              ...helper.ports,
                              ...carriable(carried.tcp)
                                  .filter((port) => !WEB_PORTS.some((web) => web === port))
                                  .map(published("tcp")),
                              ...(config.frp ? carriable(carried.udp).map(published("udp")) : [])
                          ]
                        : helper.ports,
                extraHosts: home ? [HOST_GATEWAY] : helper.extraHosts
            },
            ...rest,
            ...frp
        ]
    };
}

/** The relay end's container, which holds the link and the carried ports. */
export function relayHelper(): string {
    return wg.endNames(RELAY_ID, "public").helper;
}

/** The compose project of one end, for taking it down. */
export function relayProject(end: "relay" | "home"): string {
    return wg.endNames(RELAY_ID, end === "relay" ? "public" : "nat").project;
}
