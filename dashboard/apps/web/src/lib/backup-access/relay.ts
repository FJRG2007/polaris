/**
 * The own-relay path, the pure half: the two WireGuard ends' config files and
 * the containers that run them.
 *
 * Same shape as the self-hosted relays that settled this (a WireGuard endpoint on
 * a cloud server forwarding the public ports into a link the house dials out on),
 * built from the pieces Polaris' WireGuard tunnels already run: its own userspace
 * WireGuard daemon, so neither end needs NET_ADMIN, a TUN device or a kernel
 * module, and both fit the shapes the host daemon allows.
 *
 * Two links, nested. The web link carries the web ports and nothing that changes:
 * the house end dials the relay with a keepalive and hands 80 to this machine and
 * 443 to the edge directly (see `RELAY_EDGE_NETWORK`), so Traefik answers as it
 * does on the direct path. The web ports are not published: 80 and 443 belong to
 * the server's own edge, which hands the house's hostnames to the relay and goes
 * on serving everything else, so a server can be a relay and a deploy target at
 * once.
 *
 * Every other port - games, call media, the tunnels' listen ports - rides the side
 * link: a second pair of daemons whose WireGuard datagrams travel inside the web
 * link through one UDP forward that is the same in every config, so it needs no
 * public port of its own. UDP crosses it as UDP, each datagram on its own, so a
 * lost or late packet never holds up the ones behind it - the 5-7 s call freezes
 * of carrying UDP inside a TCP stream are gone. TCP crosses it end to end, one
 * connection per player. The side link runs in containers of its own so that a
 * server added or removed recreates only them, never the link the web rides (see
 * `relaySpec`).
 */

import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import type { ComposeSpec } from "@polaris/deploy";
import * as wg from "@/lib/deploy/wireguard/tunnel-config";

/** The UDP port the relay listens on: one past the range WireGuard tunnels hand
 *  out, so the two never ask a server for the same port. */
export const RELAY_LISTEN_PORT = wg.LAST_LISTEN_PORT + 1;
/** The link's addresses. Each end runs in its own network namespace, so the slot
 *  never meets a tunnel's. */
export const RELAY_SLOT = 16383;
/** Raised when both ends must be brought up again with what this build renders. */
export const RELAY_SPEC = 6;
/** The web ports every relay carries. */
export const WEB_PORTS = [80, 443] as const;
/**
 * The side link's WireGuard port: where the side relay listens on its own
 * container's network, and where the web link's constant forward carries it, on
 * the relay's tunnel address and on the house end's network. The relay's own
 * port number, which no carried port is given, so it never meets one.
 */
export const SIDE_WIRE_PORT = RELAY_LISTEN_PORT;
/** The side link's addresses, in namespaces of their own like the web link's. */
export const RELAY_SIDE_SLOT = 16382;
/** The compose names of the side link's ends, beside the web link's. */
export const RELAY_SIDE_ID = "00000051de00";
/** The web link's MTU, the daemon's default, which fits a 1500-byte path over
 *  IPv6 (1500 - 40 - 8 - 32). */
export const RELAY_MTU = 1420;
/**
 * What one side packet gains when it is wrapped for the web link, whose addresses
 * are IPv4: the IP header (20), UDP (8), and WireGuard's data header and tag
 * (16 + 16). Over IPv6 addresses it would be 80.
 */
export const NESTED_OVERHEAD = 20 + 8 + 32;
/**
 * The side link's MTU: one side packet, wrapped, is exactly one web link packet,
 * so the web link never fragments. A multiple of 16, so WireGuard's padding never
 * adds to it. A game datagram larger than one side packet is fragmented inside the
 * side link and joined at the other end, as a kernel tunnel would.
 */
export const SIDE_MTU = RELAY_MTU - NESTED_OVERHEAD;
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
        // The link's own UDP port, which the side link uses inside it too.
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

/** The ports that ride the side link rather than the web link: every carried
 *  port but the web ones. Games, calls and tunnels come and go; the web ports
 *  never do. */
function sidePorts(carried: RelayPortSet): RelayPortSet {
    return {
        tcp: carriable(carried.tcp).filter((port) => !WEB_PORTS.some((web) => web === port)),
        udp: [...carriable(carried.udp)]
    };
}

/** Whether there is anything for the side link to carry. */
function carriesSide(carried: RelayPortSet): boolean {
    const side = sidePorts(carried);
    return side.tcp.length + side.udp.length > 0;
}

/** PKCS #8 for an X25519 private key, up to the 32 key bytes (RFC 8410). */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** A key pair derived from one of the web link's private keys: the side link's
 *  keys are never stored, and both ends always agree on them. */
function sideKeyPair(privateKey: string): wg.KeyPair {
    const seed = createHmac("sha256", key(privateKey))
        .update("polaris-backup-relay-side")
        .digest();
    // Clamped, as every X25519 private key is written.
    seed[0] = (seed[0] ?? 0) & 248;
    seed[31] = ((seed[31] ?? 0) & 127) | 64;
    const der = Buffer.concat([X25519_PKCS8_PREFIX, seed]);
    const jwk = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({
        format: "jwk"
    });
    return {
        privateKey: seed.toString("base64"),
        publicKey: Buffer.from(jwk.x ?? "", "base64url").toString("base64")
    };
}

/** The side link's two key pairs. */
export function sideKeys(keys: RelayKeys): RelayKeys {
    return { relay: sideKeyPair(keys.relay.privateKey), home: sideKeyPair(keys.home.privateKey) };
}

/** The relay end: listens for the house, forwards the web ports into the link, and
 *  hands the side link's datagrams to the side relay. The same file whatever games
 *  are installed, so adding one never restarts the link the web rides. */
export function renderRelayConfig(keys: RelayKeys): string {
    const { publicAddress, peerAddress } = wg.slotAddresses(RELAY_SLOT);
    return [
        "[Interface]",
        `PrivateKey = ${key(keys.relay.privateKey)}`,
        `Address = ${publicAddress}/32`,
        `ListenPort = ${RELAY_LISTEN_PORT}`,
        `MTU = ${RELAY_MTU}`,
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
        // The side relay runs in a container of its own, found by name on the
        // project's network: it publishes the side ports, which this container
        // would otherwise have to. The name is looked up again while datagrams
        // flow, so a side relay recreated on a new address is followed.
        "[UDPServerTunnel]",
        `ListenPort = ${SIDE_WIRE_PORT}`,
        `Target = ${relaySide()}:${SIDE_WIRE_PORT}`,
        ""
    ].join("\n");
}

/** The house end: dials the relay, keeps the mapping open, hands the web ports to
 *  this machine, and gives the side link its way to the relay. Constant like the
 *  relay's. */
export function renderHomeConfig(keys: RelayKeys, relayAddress: string): string {
    const { publicAddress, peerAddress } = wg.slotAddresses(RELAY_SLOT);
    const endpoint = `${relayAddress.includes(":") ? `[${relayAddress}]` : relayAddress}:${RELAY_LISTEN_PORT}`;
    if (!wg.isHostPort(endpoint)) throw new Error("The relay's address is not an address");
    return [
        "[Interface]",
        `PrivateKey = ${key(keys.home.privateKey)}`,
        `Address = ${peerAddress}/32`,
        `MTU = ${RELAY_MTU}`,
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
        // On the project's network, where the house's side end dials it by name.
        "[UDPProxyTunnel]",
        `BindAddress = 0.0.0.0:${SIDE_WIRE_PORT}`,
        `Target = ${publicAddress}:${SIDE_WIRE_PORT}`,
        ""
    ].join("\n");
}

/** The side relay: listens for the house's side end inside the web link, and
 *  forwards each side port into the side link, TCP as TCP and UDP as UDP. */
export function renderSideRelayConfig(keys: RelayKeys, carried: RelayPortSet): string {
    const side = sidePorts(carried);
    const pairs = sideKeys(keys);
    const { publicAddress, peerAddress } = wg.slotAddresses(RELAY_SIDE_SLOT);
    const forward = (section: string) => (port: number) => [
        section,
        `BindAddress = 0.0.0.0:${port}`,
        `Target = ${peerAddress}:${port}`,
        ""
    ];
    return [
        "[Interface]",
        `PrivateKey = ${pairs.relay.privateKey}`,
        `Address = ${publicAddress}/32`,
        `ListenPort = ${SIDE_WIRE_PORT}`,
        `MTU = ${SIDE_MTU}`,
        "",
        "[Peer]",
        `PublicKey = ${pairs.home.publicKey}`,
        `AllowedIPs = ${peerAddress}/32`,
        "",
        ...side.tcp.flatMap(forward("[TCPClientTunnel]")),
        ...side.udp.flatMap(forward("[UDPProxyTunnel]"))
    ].join("\n");
}

/** The house's side end: dials the side relay through the web link's forward and
 *  hands each side port to the same port on this machine. TCP goes to the gateway,
 *  as the web link hands it; UDP to `local`, because the call server binds its UDP
 *  port to the LAN address alone, so the gateway reaches a game's published port
 *  but drops every packet of a call. */
export function renderSideHomeConfig(
    keys: RelayKeys,
    carried: RelayPortSet,
    local: string = HOST_ALIAS
): string {
    const side = sidePorts(carried);
    const pairs = sideKeys(keys);
    const { publicAddress, peerAddress } = wg.slotAddresses(RELAY_SIDE_SLOT);
    const udpHost = local.includes(":") ? `[${local}]` : local;
    if (!wg.isHostPort(`${udpHost}:1`)) throw new Error("The LAN address is not an address");
    const forward = (section: string, host: string) => (port: number) => [
        section,
        `ListenPort = ${port}`,
        `Target = ${host}:${port}`,
        ""
    ];
    return [
        "[Interface]",
        `PrivateKey = ${pairs.home.privateKey}`,
        `Address = ${peerAddress}/32`,
        `MTU = ${SIDE_MTU}`,
        "",
        "[Peer]",
        `PublicKey = ${pairs.relay.publicKey}`,
        `Endpoint = ${wg.endNames(RELAY_ID, "nat").helper}:${SIDE_WIRE_PORT}`,
        `AllowedIPs = ${publicAddress}/32`,
        `PersistentKeepalive = ${wg.KEEPALIVE_SECONDS}`,
        "",
        ...side.tcp.flatMap(forward("[TCPServerTunnel]", HOST_ALIAS)),
        ...side.udp.flatMap(forward("[UDPServerTunnel]", udpHost))
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
    /** The side link's end; null when there is no side port to carry. */
    readonly side: string | null;
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
            side: side ? renderSideRelayConfig(keys, carried) : null
        },
        home: {
            wireguard: renderHomeConfig(keys, relayAddress),
            side: side ? renderSideHomeConfig(keys, carried, lanAddress ?? HOST_ALIAS) : null
        }
    };
}

/**
 * The containers of one end: the WireGuard tunnels' own two-container shape for
 * the web link, which carries the web ports and the side link's datagrams and
 * nothing that changes, plus the same shape again for the side link whenever there
 * is a side port to carry.
 *
 * The split is what keeps the web up while games come and go. Docker cannot add a
 * published port to a running container, so whatever publishes the game ports is
 * recreated each time one is added or removed; when that was the web link itself,
 * every new server took every hostname behind the relay down until both ends had
 * dialled each other again. Now only the side link is recreated, and only the side
 * ports blink while it shakes hands again.
 *
 * On the relay end the side helper publishes the side ports and is found by name
 * on the project's own network, which the web helper joins besides the edge's; its
 * daemon serves no status endpoint, because a side port may need that port number.
 * On the house end the side helper dials the web helper by name on the project's
 * network, and pins the gateway in its files as the web helper does.
 */
export function relaySpec(
    end: "relay" | "home",
    config: RelayEndConfig,
    carried: RelayPortSet,
    networks: string[] = []
): ComposeSpec {
    const home = end === "home";
    const spec = wg.endSpec({
        tunnelId: RELAY_ID,
        end: home ? "nat" : "public",
        config: config.wireguard,
        networks,
        listenPort: home ? undefined : RELAY_LISTEN_PORT,
        hostAlias: home ? HOST_ALIAS : undefined
    });
    const [helper, ...rest] = spec.services;
    if (!helper) throw new Error("A WireGuard end has no helper container");
    const services: ComposeSpec["services"] = [
        {
            ...helper,
            // `default` is the way out to the relay at the house, where the edge's
            // network is internal, and the way to the side relay on the relay.
            networks: home ? ["default", RELAY_EDGE_NETWORK] : ["default", ...helper.networks],
            extraHosts: home ? [HOST_GATEWAY] : helper.extraHosts
        },
        ...rest
    ];
    const volumes = [...(spec.volumes ?? [])];
    if (config.side) {
        const side = wg.endSpec({
            tunnelId: RELAY_SIDE_ID,
            end: home ? "nat" : "public",
            config: config.side,
            networks: ["default"],
            hostAlias: home ? HOST_ALIAS : undefined,
            status: home
        });
        const [sideHelper, ...sideRest] = side.services;
        if (!sideHelper) throw new Error("A WireGuard end has no helper container");
        const ports = sidePorts(carried);
        const published = (protocol: "tcp" | "udp") => (port: number) => ({
            host: port,
            container: port,
            protocol
        });
        services.push(
            {
                ...sideHelper,
                ports: home
                    ? []
                    : [...ports.tcp.map(published("tcp")), ...ports.udp.map(published("udp"))],
                extraHosts: home ? [HOST_GATEWAY] : sideHelper.extraHosts,
                // After the web helper: on the relay, one from before the split still
                // publishes these ports until it is recreated or removed.
                dependsOn: [helper.name]
            },
            ...sideRest
        );
        volumes.push(...(side.volumes ?? []));
    }
    return {
        ...spec,
        networks: home ? [RELAY_EDGE_NETWORK] : spec.networks,
        services,
        volumes
    };
}

/** The relay end's container, which holds the link. */
export function relayHelper(): string {
    return wg.endNames(RELAY_ID, "public").helper;
}

/** The relay end's side helper, which publishes the side ports. */
export function relaySide(): string {
    return wg.endNames(RELAY_SIDE_ID, "public").helper;
}

/** The compose project of one end, for taking it down. */
export function relayProject(end: "relay" | "home"): string {
    return wg.endNames(RELAY_ID, end === "relay" ? "public" : "nat").project;
}
