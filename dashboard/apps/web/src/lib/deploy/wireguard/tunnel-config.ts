/**
 * WireGuard tunnels, the pure half: keys, addresses, the two ends' config files,
 * the containers that run them, the edge routes, and the reading of a live tunnel.
 *
 * Nothing here touches the database, a daemon or the network, so every decision
 * that can be wrong - an address handed out twice, a keepalive missing on the end
 * that sits behind NAT, a router without a priority - is asserted in a test.
 *
 * Each end is userspace WireGuard (wireproxy): it needs no NET_ADMIN, no TUN
 * device and no kernel module, so it runs inside the shapes the host daemon
 * already allows. The public end listens on one UDP port and forwards a TCP port
 * into the tunnel; the end behind NAT dials out with a keepalive and forwards what
 * arrives to the service, so nothing opens at home.
 */

import { generateKeyPairSync } from "node:crypto";
import type { ComposeSpec } from "@polaris/deploy";
import { isRouteHostname } from "./tunnel-hostname";

export { isRouteHostname };

/**
 * Userspace WireGuard, pinned to the commit tagged v1.1.3 (2026-07-16). The
 * project publishes its image under the commit hash and `latest`, never under the
 * release name, so the hash is the only tag that cannot move under a running
 * tunnel. Distroless and unprivileged; its `/metrics` answers with the device's
 * own state, which is how the screen reads the handshake.
 */
export const WIREGUARD_IMAGE = "ghcr.io/windtf/wireproxy:31a9a34498267d7fb8aeff05aba79d929b15eb39";

/**
 * The companion that writes the config file and owns the network namespace both
 * containers share. The WireGuard image has no shell, so the file is decoded here,
 * and the status endpoint stays on loopback where only this container can read it.
 */
export const HELPER_IMAGE = "busybox:1.37.0";

/** The first UDP port a public server listens on, and the last one handed out. */
export const FIRST_LISTEN_PORT = 51820;
export const LAST_LISTEN_PORT = 51999;

/** The TCP port each end forwards through the tunnel. Inside the containers only. */
export const TUNNEL_TCP_PORT = 8080;

/** Where the status endpoint listens: loopback in the shared namespace. */
export const STATUS_ADDRESS = "127.0.0.1:9080";

/** Seconds between keepalives from the end behind NAT: under every common NAT
 *  mapping timeout, the figure WireGuard's own documentation suggests. */
export const KEEPALIVE_SECONDS = 25;

/** A handshake is renewed every two minutes while traffic or keepalives flow. One
 *  older than three has stopped. */
export const HANDSHAKE_FRESH_SECONDS = 180;

/** Tunnel addresses come from 10.213.0.0/16, four to a slot: 16384 slots. */
const SLOT_COUNT = 16384;

/** Rank of a tunnel's router: the same as a deployed app's own hostname, under the
 *  dashboard's public hostnames (50) and over the compose-label catch-all (10). */
export const TUNNEL_ROUTE_PRIORITY = 40;

/** The edge file the tunnels own. Nothing else writes it. */
export const TUNNEL_ROUTE_FILE = "polaris-wireguard.yml";

export interface KeyPair {
    readonly privateKey: string;
    readonly publicKey: string;
}

/** A Curve25519 key pair in WireGuard's base64 form. */
export function generateKeyPair(): KeyPair {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const priv = privateKey.export({ format: "jwk" });
    const pub = publicKey.export({ format: "jwk" });
    return { privateKey: fromBase64Url(priv.d ?? ""), publicKey: fromBase64Url(pub.x ?? "") };
}

function fromBase64Url(value: string): string {
    return Buffer.from(value, "base64url").toString("base64");
}

/** A WireGuard key: 32 bytes in base64. */
export function isWireguardKey(value: string): boolean {
    return /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/.test(value);
}

/** The key as UAPI writes it: lowercase hex. */
export function keyToHex(key: string): string {
    return Buffer.from(key, "base64").toString("hex");
}

/** The two addresses of a slot: the public end's and the NAT end's. */
export function slotAddresses(slot: number): { publicAddress: string; peerAddress: string } {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT)
        throw new RangeError(`No tunnel slot ${slot}`);
    const base = slot * 4;
    const third = Math.floor(base / 256);
    const fourth = base % 256;
    return {
        publicAddress: `10.213.${third}.${fourth + 1}`,
        peerAddress: `10.213.${third}.${fourth + 2}`
    };
}

/** The lowest slot nobody holds, or null when all are taken. */
export function allocateSlot(used: Iterable<number>): number | null {
    const taken = new Set(used);
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) if (!taken.has(slot)) return slot;
    return null;
}

/** The lowest listening port free on a public server, or null when all are taken. */
export function allocateListenPort(used: Iterable<number>): number | null {
    const taken = new Set(used);
    for (let port = FIRST_LISTEN_PORT; port <= LAST_LISTEN_PORT; port += 1)
        if (!taken.has(port)) return port;
    return null;
}

/** A value written into the config file: refused if it could start another line. */
function line(value: string, what: string): string {
    if (/[\u0000-\u001f\u007f]/.test(value) || value.trim() !== value || value === "") {
        throw new Error(`The tunnel's ${what} is not a single plain value`);
    }
    return value;
}

/** A host:port target or endpoint: a name or address and a port, nothing else. */
export function isHostPort(value: string): boolean {
    const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
    if (!match) return false;
    const port = Number(match[2]);
    return port >= 1 && port <= 65535;
}

export interface PublicEndInput {
    readonly privateKey: string;
    readonly peerPublicKey: string;
    readonly slot: number;
    readonly listenPort: number;
}

/** The public end: listens on its UDP port, accepts only the NAT end's key from only
 *  its tunnel address, and forwards the edge's TCP port to the NAT end. */
export function renderPublicConfig(input: PublicEndInput): string {
    const { publicAddress, peerAddress } = slotAddresses(input.slot);
    assertKey(input.privateKey);
    assertKey(input.peerPublicKey);
    return [
        "[Interface]",
        `PrivateKey = ${input.privateKey}`,
        `Address = ${publicAddress}/32`,
        `ListenPort = ${input.listenPort}`,
        "",
        "[Peer]",
        `PublicKey = ${input.peerPublicKey}`,
        `AllowedIPs = ${peerAddress}/32`,
        "",
        "[TCPClientTunnel]",
        `BindAddress = 0.0.0.0:${TUNNEL_TCP_PORT}`,
        `Target = ${peerAddress}:${TUNNEL_TCP_PORT}`,
        ""
    ].join("\n");
}

export interface NatEndInput {
    readonly privateKey: string;
    readonly peerPublicKey: string;
    readonly slot: number;
    /** host:port of the public server's UDP listener. */
    readonly endpoint: string;
    /** host:port of the service, as this end's network reaches it. */
    readonly origin: string;
}

/** The end behind NAT: dials the public server and keeps the mapping open, and
 *  hands what arrives on its tunnel address to the service. */
export function renderNatConfig(input: NatEndInput): string {
    const { publicAddress, peerAddress } = slotAddresses(input.slot);
    assertKey(input.privateKey);
    assertKey(input.peerPublicKey);
    if (!isHostPort(input.endpoint))
        throw new Error("The public server's address is not a host and port");
    if (!isHostPort(input.origin)) throw new Error("The service's address is not a host and port");
    return [
        "[Interface]",
        `PrivateKey = ${input.privateKey}`,
        `Address = ${peerAddress}/32`,
        "",
        "[Peer]",
        `PublicKey = ${input.peerPublicKey}`,
        `Endpoint = ${line(input.endpoint, "endpoint")}`,
        `AllowedIPs = ${publicAddress}/32`,
        `PersistentKeepalive = ${KEEPALIVE_SECONDS}`,
        "",
        "[TCPServerTunnel]",
        `ListenPort = ${TUNNEL_TCP_PORT}`,
        `Target = ${line(input.origin, "service address")}`,
        ""
    ].join("\n");
}

function assertKey(key: string): void {
    if (!isWireguardKey(key)) throw new Error("A tunnel key is not a WireGuard key");
}

/** Compose names for one end of one tunnel. Container names are global on a host,
 *  so the tunnel id is in every one of them. */
export function endNames(
    tunnelId: string,
    end: "public" | "nat"
): { project: string; helper: string; wireguard: string } {
    const id = tunnelId
        .replace(/[^a-f0-9]/gi, "")
        .slice(-12)
        .toLowerCase();
    const tag = end === "public" ? "pub" : "nat";
    return {
        project: `polaris-wg-${tag}-${id}`,
        helper: `wg-${tag}-${id}`,
        wireguard: `wg-${tag}-${id}-wg`
    };
}

/** The address the edge dials: the public end's helper, which owns the namespace. */
export function edgeUpstream(tunnelId: string): string {
    return `http://${endNames(tunnelId, "public").helper}:${TUNNEL_TCP_PORT}`;
}

export interface EndSpecInput {
    readonly tunnelId: string;
    readonly end: "public" | "nat";
    readonly config: string;
    readonly networks: string[];
    /** The UDP port published on the public end. */
    readonly listenPort?: number;
    /** More files the helper writes beside the config, for a container that joins
     *  the same namespace. Root-owned and readable by root only. */
    readonly extraFiles?: readonly { name: string; content: string }[];
    /** A name Docker keeps in the helper's hosts file. WireGuard's resolver asks DNS
     *  only and never finds it, so the files get the address instead. */
    readonly hostAlias?: string;
}

/**
 * The two containers of one end. The helper decodes the config into a volume both
 * mount, then stays up holding the network namespace; WireGuard joins that
 * namespace, so the published UDP port, the forwarded TCP port and the loopback
 * status endpoint are all on one address. The config travels base64-encoded: it
 * is a file, and the daemon refuses a newline in any environment value or argument.
 */
export function endSpec(input: EndSpecInput): ComposeSpec {
    const names = endNames(input.tunnelId, input.end);
    const volume = `${names.helper}-conf`;
    const extras = input.extraFiles ?? [];
    for (const file of extras)
        if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(file.name) || file.name === "config")
            throw new Error("A tunnel file name is not a plain file name");
    const extraEnv = Object.fromEntries(
        extras.map((file, index) => [
            `WG_FILE_${index}`,
            Buffer.from(file.content, "utf8").toString("base64")
        ])
    );
    const owned = ["config", ...extras.map((file) => file.name)]
        .map((name) => `/etc/wireproxy/${name}`)
        .join(" ");
    const alias = input.hostAlias;
    if (alias && !/^[a-z0-9][a-z0-9.-]*$/.test(alias))
        throw new Error("A tunnel host alias is not a plain name");
    const pin = alias ? ` | sed "s/${alias}/\${PINNED:-${alias}}/g"` : "";
    const script = [
        "set -e",
        ...(alias
            ? [
                  `PINNED=$(grep -F ${alias} /etc/hosts | head -n 1 | tr -s ' \\t' ' ' | cut -d ' ' -f 1)`
              ]
            : []),
        `printf %s "$WG_CONFIG" | base64 -d${pin} > /etc/wireproxy/config`,
        // The WireGuard image runs as the distroless nonroot user.
        "chown 65532:65532 /etc/wireproxy/config",
        "chmod 0400 /etc/wireproxy/config",
        ...extras.flatMap((file, index) => [
            `printf %s "$WG_FILE_${index}" | base64 -d${pin} > /etc/wireproxy/${file.name}`,
            `chmod 0400 /etc/wireproxy/${file.name}`
        ]),
        // The files hold secrets: they do not outlive the tunnel's containers.
        `trap 'rm -f ${owned}; exit 0' TERM INT`,
        "while :; do sleep 3600 & wait $!; done"
    ].join("; ");
    return {
        project: names.project,
        services: [
            {
                name: names.helper,
                image: HELPER_IMAGE,
                pullPolicy: "missing",
                env: {
                    WG_CONFIG: Buffer.from(input.config, "utf8").toString("base64"),
                    ...extraEnv
                },
                ports: input.listenPort
                    ? [{ host: input.listenPort, container: input.listenPort, protocol: "udp" }]
                    : [],
                volumes: [{ kind: "volume", source: volume, target: "/etc/wireproxy" }],
                labels: {},
                command: ["sh", "-c", script],
                networks: input.networks,
                restart: "unless-stopped"
            },
            {
                name: names.wireguard,
                image: WIREGUARD_IMAGE,
                pullPolicy: "missing",
                env: {},
                ports: [],
                volumes: [{ kind: "volume", source: volume, target: "/etc/wireproxy" }],
                labels: {},
                command: ["--config", "/etc/wireproxy/config", "--info", STATUS_ADDRESS],
                networks: [],
                networkMode: `service:${names.helper}`,
                dependsOn: [names.helper],
                // The first start can beat the helper's write; it simply starts again.
                restart: "unless-stopped"
            }
        ],
        volumes: [volume],
        networks: input.networks
    };
}

/** The command the helper runs to read the live device state. */
export function statusCommand(): string[] {
    return ["wget", "-q", "-T", "3", "-O", "-", `http://${STATUS_ADDRESS}/metrics`];
}

export interface PeerReading {
    /** Hex, as UAPI writes it. */
    readonly publicKeyHex: string;
    readonly endpoint: string | null;
    /** Unix seconds of the last handshake, 0 for never. */
    readonly lastHandshake: number;
    readonly rxBytes: number;
    readonly txBytes: number;
}

/**
 * Read the device state WireGuard reports over its configuration protocol
 * (`key=value` lines; a `public_key` line opens each peer). The same fields
 * `wg show <iface> dump` prints, in the form this image serves them.
 */
export function parseDeviceState(text: string): PeerReading[] {
    const peers: PeerReading[] = [];
    let current: {
        publicKeyHex: string;
        endpoint: string | null;
        sec: number;
        rx: number;
        tx: number;
    } | null = null;
    const close = (): void => {
        if (current) {
            peers.push({
                publicKeyHex: current.publicKeyHex,
                endpoint: current.endpoint,
                lastHandshake: current.sec,
                rxBytes: current.rx,
                txBytes: current.tx
            });
        }
    };
    for (const raw of text.split(/\r?\n/)) {
        const at = raw.indexOf("=");
        if (at <= 0) continue;
        const key = raw.slice(0, at).trim();
        const value = raw.slice(at + 1).trim();
        if (key === "public_key") {
            close();
            current = { publicKeyHex: value.toLowerCase(), endpoint: null, sec: 0, rx: 0, tx: 0 };
            continue;
        }
        if (!current) continue;
        const number = Number(value);
        if (key === "endpoint") current.endpoint = value || null;
        else if (key === "last_handshake_time_sec" && Number.isFinite(number)) current.sec = number;
        else if (key === "rx_bytes" && Number.isFinite(number)) current.rx = number;
        else if (key === "tx_bytes" && Number.isFinite(number)) current.tx = number;
    }
    close();
    return peers;
}

export type TunnelHealth = "up" | "waiting" | "down";

/** Up while handshakes are fresh; waiting until the first one; down once they stop. */
export function tunnelHealth(lastHandshake: number, nowSeconds: number): TunnelHealth {
    if (lastHandshake <= 0) return "waiting";
    return nowSeconds - lastHandshake <= HANDSHAKE_FRESH_SECONDS ? "up" : "down";
}

export interface TunnelRoute {
    readonly id: string;
    readonly hostname: string;
}

/**
 * The edge file for the tunnels a public server terminates: one HTTPS router per
 * hostname with a certificate, and its plain-HTTP twin that redirects. Every router
 * carries an explicit priority. Always a valid, non-empty document - with no
 * tunnels it still declares its middleware - so the edge never reads an empty file.
 */
export function renderTunnelRoutes(routes: readonly TunnelRoute[]): string {
    const usable = routes.filter((route) => isRouteHostname(route.hostname));
    const lines = [
        "http:",
        "  middlewares:",
        "    polaris-wg-https:",
        "      redirectScheme:",
        "        scheme: https"
    ];
    if (usable.length === 0) return `${lines.join("\n")}\n`;
    lines.push("  routers:");
    for (const route of usable) {
        const name = routerName(route.id);
        const rule = `"Host(\`${route.hostname}\`)"`;
        lines.push(
            `    ${name}:`,
            `      rule: ${rule}`,
            "      entryPoints: [websecure]",
            `      priority: ${TUNNEL_ROUTE_PRIORITY}`,
            `      service: ${name}`,
            "      tls:",
            "        certResolver: letsencrypt",
            `    ${name}-http:`,
            `      rule: ${rule}`,
            "      entryPoints: [web]",
            `      priority: ${TUNNEL_ROUTE_PRIORITY}`,
            `      service: ${name}`,
            "      middlewares: [polaris-wg-https]"
        );
    }
    lines.push("  services:");
    for (const route of usable) {
        lines.push(
            `    ${routerName(route.id)}:`,
            "      loadBalancer:",
            "        servers:",
            `          - url: "${edgeUpstream(route.id)}"`
        );
    }
    return `${lines.join("\n")}\n`;
}

function routerName(id: string): string {
    return `polaris-wg-${endNames(id, "public").helper.slice("wg-pub-".length)}`;
}
