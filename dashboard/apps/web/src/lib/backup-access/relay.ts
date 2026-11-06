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
 * The link carries the web ports and nothing that changes: the house end dials the
 * relay with a keepalive and hands 80 to this machine and 443 to the edge directly
 * (see `RELAY_EDGE_NETWORK`), so Traefik answers as it does on the direct path. The
 * web ports are not published: 80 and 443 belong to the server's own edge, which
 * hands the house's hostnames to the relay and goes on serving everything else, so
 * a server can be a relay and a deploy target at once.
 *
 * Every other port - games, call media, the tunnels' listen ports - rides frp, the
 * way self-hosted game servers are usually relayed: frps on the relay end publishes
 * them, frpc at the house dials it through the link and hands each to the same port
 * here. They run in containers of their own so that a server added or removed
 * recreates only frp, never the link the web rides (see `relaySpec`).
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
export const RELAY_SPEC = 4;
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

/** The ports that ride frp rather than the link: every carried port but the web
 *  ones. Games, calls and tunnels come and go; the web ports never do. */
function sidePorts(carried: RelayPortSet): RelayPortSet {
    return {
        tcp: carriable(carried.tcp).filter((port) => !WEB_PORTS.some((web) => web === port)),
        udp: [...carriable(carried.udp)]
    };
}

/** Whether there is anything for frp to carry. */
function carriesSide(carried: RelayPortSet): boolean {
    const side = sidePorts(carried);
    return side.tcp.length + side.udp.length > 0;
}

/** The relay end: listens for the house, forwards the web ports into the link, and
 *  lets the house's frpc reach frps. The same file whatever games are installed, so
 *  adding one never restarts the link the web rides. */
export function renderRelayConfig(keys: RelayKeys): string {
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
        ...WEB_PORTS.flatMap((port) => [
            "[TCPClientTunnel]",
            `BindAddress = 0.0.0.0:${port}`,
            `Target = ${peerAddress}:${port}`,
            ""
        ]),
        // frps runs in a container of its own, found by name on the project's network:
        // it publishes the side ports, which this container would otherwise have to.
        "[TCPServerTunnel]",
        `ListenPort = ${FRP_CONTROL_PORT}`,
        `Target = ${relayFrp()}:${FRP_CONTROL_PORT}`,
        ""
    ].join("\n");
}

/** The house end: dials the relay, keeps the mapping open, hands the web ports to
 *  this machine, and gives frpc its way to frps. Constant like the relay's. */
export function renderHomeConfig(keys: RelayKeys, relayAddress: string): string {
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
        ...WEB_PORTS.flatMap((port) => [
            "[TCPServerTunnel]",
            `ListenPort = ${port}`,
            `Target = ${port === TLS_PORT ? RELAY_EDGE_ADDRESS : HOST_ALIAS}:${port}`,
            ""
        ]),
        "[TCPClientTunnel]",
        `BindAddress = 127.0.0.1:${FRP_CONTROL_PORT}`,
        `Target = ${publicAddress}:${FRP_CONTROL_PORT}`,
        ""
    ].join("\n");
}

/** The secret frpc logs in to frps with. frps is only reachable through the link
 *  and its own project's network already, so this is a second lock; derived from
 *  the house's key, so nothing new is stored and both ends always agree. */
export function frpToken(keys: RelayKeys): string {
    return createHmac("sha256", key(keys.home.privateKey))
        .update("polaris-backup-relay-frp")
        .digest("hex");
}

/** frps on the relay end: its control port on its own container's network, which
 *  is never published, each side port listening publicly, and no other allowed. */
export function renderRelayFrp(keys: RelayKeys, carried: RelayPortSet): string {
    const side = sidePorts(carried);
    const allowed = [...new Set([...side.tcp, ...side.udp])]
        .sort((a, b) => a - b)
        .map((port) => `{ single = ${port} }`);
    return [
        'bindAddr = "0.0.0.0"',
        `bindPort = ${FRP_CONTROL_PORT}`,
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
 *  up, and hands each side port to the same port on this machine. TCP goes to the
 *  gateway, as the link handed it before; UDP to `local`, because the call server
 *  binds its UDP port to the LAN address alone, so the gateway reaches a game's
 *  published port but drops every packet of a call. */
export function renderHomeFrp(
    keys: RelayKeys,
    carried: RelayPortSet,
    local: string = HOST_ALIAS
): string {
    const side = sidePorts(carried);
    const proxy = (type: "tcp" | "udp", localIP: string) => (port: number) => [
        "[[proxies]]",
        `name = "${type}-${port}"`,
        `type = "${type}"`,
        `localIP = "${localIP}"`,
        `localPort = ${port}`,
        `remotePort = ${port}`,
        ""
    ];
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
        ...side.tcp.flatMap(proxy("tcp", HOST_ALIAS)),
        ...side.udp.flatMap(proxy("udp", local))
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
    /** frps' or frpc's config; null when there is no side port to carry. */
    readonly frp: string | null;
}

/** Both ends' files for one set of ports. */
export function relayConfigs(
    keys: RelayKeys,
    relayAddress: string,
    carried: RelayPortSet,
    lanAddress: string | null = null
): { relay: RelayEndConfig; home: RelayEndConfig } {
    const side = carriesSide(carried);
    return {
        relay: {
            wireguard: renderRelayConfig(keys),
            frp: side ? renderRelayFrp(keys, carried) : null
        },
        home: {
            wireguard: renderHomeConfig(keys, relayAddress),
            frp: side ? renderHomeFrp(keys, carried, lanAddress ?? HOST_ALIAS) : null
        }
    };
}

/**
 * How an frp container starts: its config arrives in the environment, is written
 * where only it reads it, and the binary takes over. The house's pins the gateway to
 * the address in the hosts file it shares with the helper, as the helper does for
 * WireGuard, so the link and frp hand ports to the same place.
 */
function frpCommand(binary: "frps" | "frpc", pin: boolean): string {
    const sed = pin ? ` | sed "s/${HOST_ALIAS}/\${PINNED:-${HOST_ALIAS}}/g"` : "";
    return [
        "set -e",
        ...(pin
            ? [
                  `PINNED=$(grep -F ${HOST_ALIAS} /etc/hosts | head -n 1 | tr -s ' \\t' ' ' | cut -d ' ' -f 1)`
              ]
            : []),
        `printf %s "$FRP_CONFIG" | base64 -d${sed} > /tmp/frp.toml`,
        "chmod 0400 /tmp/frp.toml",
        `exec /usr/bin/${binary} -c /tmp/frp.toml`
    ].join("; ");
}

/**
 * The containers of one end: the WireGuard tunnels' own two-container shape, which
 * carries the web ports and frp's control connection and nothing that changes, plus
 * frp in a container of its own whenever there is a side port to carry.
 *
 * The split is what keeps the web up while games come and go. Docker cannot add a
 * published port to a running container, so whatever publishes the game ports is
 * recreated each time one is added or removed; when that was the link itself, every
 * new server took every hostname behind the relay down until both ends had dialled
 * each other again. Now only frp is recreated, and only the side ports blink.
 *
 * On the relay end frps publishes the side ports and is found by name on the
 * project's own network, which the helper joins besides the edge's. On the house end
 * frpc shares the helper's namespace, where the link's end of frp's control
 * connection listens on loopback.
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
        hostAlias: end === "home" ? HOST_ALIAS : undefined
    });
    const [helper, ...rest] = spec.services;
    if (!helper) throw new Error("A WireGuard end has no helper container");
    const home = end === "home";
    const side = sidePorts(carried);
    const published = (protocol: "tcp" | "udp") => (port: number) => ({
        host: port,
        container: port,
        protocol
    });
    const common = {
        name: `${helper.name}-frp`,
        pullPolicy: "missing" as const,
        env: { FRP_CONFIG: Buffer.from(config.frp ?? "", "utf8").toString("base64") },
        volumes: [],
        labels: {},
        entrypoint: ["sh", "-c"],
        restart: "unless-stopped"
    };
    const frp: ComposeSpec["services"] = !config.frp
        ? []
        : home
          ? [
                {
                    ...common,
                    image: FRPC_IMAGE,
                    ports: [],
                    command: [frpCommand("frpc", true)],
                    networks: [],
                    networkMode: `service:${helper.name}`,
                    dependsOn: [helper.name]
                }
            ]
          : [
                {
                    ...common,
                    image: FRPS_IMAGE,
                    ports: [...side.tcp.map(published("tcp")), ...side.udp.map(published("udp"))],
                    command: [frpCommand("frps", false)],
                    networks: ["default"],
                    // After the helper: one from before the split still publishes these
                    // ports until it is recreated, and frps would find them taken.
                    dependsOn: [helper.name]
                }
            ];
    return {
        ...spec,
        networks: home ? [RELAY_EDGE_NETWORK] : spec.networks,
        services: [
            {
                ...helper,
                // `default` is the way out to the relay at the house, where the edge's
                // network is internal, and the way to frps on the relay.
                networks: home ? ["default", RELAY_EDGE_NETWORK] : ["default", ...helper.networks],
                extraHosts: home ? [HOST_GATEWAY] : helper.extraHosts
            },
            ...rest,
            ...frp
        ]
    };
}

/** The relay end's container, which holds the link. */
export function relayHelper(): string {
    return wg.endNames(RELAY_ID, "public").helper;
}

/** The relay end's frps, which publishes the side ports. */
export function relayFrp(): string {
    return `${relayHelper()}-frp`;
}

/** The compose project of one end, for taking it down. */
export function relayProject(end: "relay" | "home"): string {
    return wg.endNames(RELAY_ID, end === "relay" ? "public" : "nat").project;
}
