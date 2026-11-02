/**
 * The VPN people use: plain WireGuard on machines an administrator connects, reached
 * from the Polaris app and extension. Pure, so everything sent to a
 * node and every limit is asserted in tests.
 *
 * Each node gives its devices a /20 of 10.128.0.0/9. A device's private key is made
 * once, handed over once and never kept; the node only ever learns its public key.
 */

import { z } from "zod";
import {
    PROXY_KEY,
    PROXY_PORT,
    PROXY_SCRIPT,
    PROXY_USER,
    PROXY_UNIT,
    TOR_SOCKS_PORT,
    renderProxyScript
} from "@/lib/vpn/browser-proxy";

export const VPN_DIR = "/etc/polaris-vpn";
/** Ubuntu confines `wg` so it can only read inside this folder, whoever runs it. */
const WG_CONFIG = "/etc/wireguard/polaris-vpn.conf";
/** Linux's 15 characters at most. */
const DEVICE = "polaris-vpn";
const TOR_TRANS_PORT = 9040;
const TOR_DNS_PORT = 5353;
const DOCKER_CHAIN = "POLARIS-VPN";
/** Docker's bridges, the only way into the browser proxy: its edge comes from there. */
const EDGE_TO_PROXY = `from 172.16.0.0/12 to any port ${PROXY_PORT} proto tcp`;
export const DEFAULT_PORT = 51820;
export const MAX_NODES = 64;
/** How many devices one node can address: a /20 less its network, gateway and broadcast. */
export const MAX_DEVICES_ON_NODE = 4093;
/** Devices a person may add unless their access says otherwise. */
export const DEFAULT_DEVICE_LIMIT = 5;
export const PUBLIC_DNS = ["1.1.1.1", "9.9.9.9"] as const;
const GIB = 1024 ** 3;

/** A WireGuard key: 32 bytes of base64. */
const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const HOST_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** How a node sends traffic out: its own connection, or through Tor. */
export const NODE_EXITS = ["direct", "tor"] as const;
export type NodeExit = (typeof NODE_EXITS)[number];

export const nodeInputSchema = z.object({
    hostId: z.string().uuid(),
    name: z.string().trim().min(1).max(40),
    /** Where devices reach it: a public address or name. */
    endpoint: z.string().trim().regex(HOST_NAME),
    port: z.number().int().min(1).max(65535),
    exit: z.enum(NODE_EXITS)
});
export type NodeInput = z.infer<typeof nodeInputSchema>;

export const accessInputSchema = z.object({
    userId: z.string().uuid(),
    /** Node ids; empty means every node. */
    nodes: z.array(z.string().uuid()).max(MAX_NODES),
    deviceLimit: z.number().int().min(0).max(1000),
    /** A month's traffic in GiB; null means no limit. */
    dataLimitGb: z.number().int().min(1).max(1_000_000).nullable(),
    expiresAt: z.coerce.date().nullable(),
    suspended: z.boolean()
});
export type AccessInput = z.infer<typeof accessInputSchema>;

export const deviceNameSchema = z.string().trim().min(1).max(40);

export function isWireGuardKey(key: string): boolean {
    return KEY.test(key);
}

/** What an app sends to connect a device: only the public half of its key. */
export const clientConnectSchema = z.object({
    nodeId: z.string().uuid(),
    name: deviceNameSchema,
    publicKey: z.string().refine(isWireGuardKey)
});

/** The block of one node, from a number no two nodes share. */
export function nodeSubnet(index: number): { base: [number, number]; cidr: string; gateway: string } {
    const second = 128 + Math.floor(index / 16);
    const third = (index % 16) * 16;
    if (second > 255) throw new Error("No node block left");
    return {
        base: [second, third],
        cidr: `10.${second}.${third}.0/20`,
        gateway: `10.${second}.${third}.1`
    };
}

/** A device's address on a node. Host 1 is the node, so devices start at 2. */
export function deviceAddress(index: number, host: number): string {
    if (host < 2 || host > MAX_DEVICES_ON_NODE + 1) throw new Error("No device address left");
    const { base } = nodeSubnet(index);
    return `10.${base[0]}.${base[1] + Math.floor(host / 256)}.${host % 256}`;
}

/** The lowest device number free on a node, or null when it is full. */
export function freeHost(taken: readonly number[]): number | null {
    const used = new Set(taken);
    for (let host = 2; host <= MAX_DEVICES_ON_NODE + 1; host += 1) {
        if (!used.has(host)) return host;
    }
    return null;
}

/** What a person's access says, whichever way it was granted. */
export interface VpnAccess {
    readonly nodes: readonly string[];
    readonly deviceLimit: number;
    readonly dataLimitGb: number | null;
    readonly expiresAt: Date | null;
    readonly suspended: boolean;
    readonly usedBytes: bigint;
}

export type AccessStanding = "active" | "suspended" | "expired" | "overLimit";

/** Whether somebody's devices may pass traffic right now. */
export function accessStanding(access: VpnAccess, now: Date): AccessStanding {
    if (access.suspended) return "suspended";
    if (access.expiresAt && access.expiresAt <= now) return "expired";
    const cap = access.dataLimitGb === null ? null : BigInt(access.dataLimitGb) * BigInt(GIB);
    return cap !== null && access.usedBytes >= cap ? "overLimit" : "active";
}

export function mayUseNode(access: VpnAccess, nodeId: string): boolean {
    return access.nodes.length === 0 || access.nodes.includes(nodeId);
}

export interface NodePlan {
    readonly index: number;
    readonly port: number;
    readonly exit: NodeExit;
}

/** The node's firewall. Devices reach the internet and nothing else on the machine or
 *  each other; a Tor node leaves no other way out, so nothing goes around Tor. */
export function renderNodeRules(node: NodePlan): string {
    const { cidr } = nodeSubnet(node.index);
    const tor = node.exit === "tor";
    return [
        "table inet polaris_vpn {}",
        "delete table inet polaris_vpn",
        "table inet polaris_vpn {",
        "    chain input {",
        "        type filter hook input priority filter - 1; policy accept;",
        `        iifname "${DEVICE}" ct state established,related accept`,
        ...(tor
            ? [
                  `        iifname "${DEVICE}" tcp dport ${TOR_TRANS_PORT} accept`,
                  `        iifname "${DEVICE}" udp dport ${TOR_DNS_PORT} accept`
              ]
            : []),
        `        iifname "${DEVICE}" drop`,
        `        tcp dport ${PROXY_PORT} ip saddr != { 127.0.0.0/8, 172.16.0.0/12 } drop`,
        "    }",
        "    chain forward {",
        "        type filter hook forward priority filter - 1; policy accept;",
        `        iifname "${DEVICE}" oifname "${DEVICE}" drop`,
        ...(tor
            ? [
                  `        iifname "${DEVICE}" drop`,
                  `        oifname "${DEVICE}" drop`
              ]
            : [
                  `        iifname "${DEVICE}" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop`
              ]),
        "    }",
        "    chain incoming {",
        "        type nat hook prerouting priority dstnat; policy accept;",
        ...(tor
            ? [
                  `        iifname "${DEVICE}" udp dport 53 redirect to :${TOR_DNS_PORT}`,
                  `        iifname "${DEVICE}" tcp flags syn redirect to :${TOR_TRANS_PORT}`
              ]
            : []),
        "    }",
        "    chain outgoing {",
        "        type nat hook postrouting priority srcnat; policy accept;",
        ...(tor ? [] : [`        ip saddr ${cidr} oifname != "${DEVICE}" masquerade`]),
        "    }",
        "}",
        ""
    ].join("\n");
}

/** Tor as a service of its own, leaving any Tor the machine already runs alone. */
export function renderTorConfig(node: NodePlan): string {
    const { gateway } = nodeSubnet(node.index);
    return [
        `SocksPort 127.0.0.1:${TOR_SOCKS_PORT}`,
        `TransPort ${gateway}:${TOR_TRANS_PORT} IsolateClientAddr`,
        `DNSPort ${gateway}:${TOR_DNS_PORT}`,
        "VirtualAddrNetworkIPv4 10.64.0.0/10",
        "AutomapHostsOnResolve 1",
        "DataDirectory /var/lib/polaris-vpn-tor",
        "User debian-tor",
        ""
    ].join("\n");
}

function renderUp(node: NodePlan): string {
    const { gateway } = nodeSubnet(node.index);
    const prefix = 20;
    return `#!/bin/sh
set -eu
ip link show ${DEVICE} >/dev/null 2>&1 || ip link add ${DEVICE} type wireguard
sh ${VPN_DIR}/peers.sh
ip -4 addr flush dev ${DEVICE}
ip addr add ${gateway}/${prefix} dev ${DEVICE}
ip link set ${DEVICE} up
nft -f ${VPN_DIR}/rules.nft
if iptables -w -n -L DOCKER-USER >/dev/null 2>&1; then
    iptables -w -N ${DOCKER_CHAIN} 2>/dev/null || iptables -w -F ${DOCKER_CHAIN}
    iptables -w -C DOCKER-USER -j ${DOCKER_CHAIN} 2>/dev/null || iptables -w -I DOCKER-USER -j ${DOCKER_CHAIN}
    iptables -w -A ${DOCKER_CHAIN} -i ${DEVICE} -j ACCEPT
    iptables -w -A ${DOCKER_CHAIN} -o ${DEVICE} -j ACCEPT
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow ${node.port}/udp >/dev/null
    ufw allow ${EDGE_TO_PROXY} >/dev/null
fi
sysctl -q -w net.ipv4.ip_forward=1
`;
}

const DOWN = `#!/bin/sh
nft delete table inet polaris_vpn 2>/dev/null
iptables -w -D DOCKER-USER -j ${DOCKER_CHAIN} 2>/dev/null
iptables -w -F ${DOCKER_CHAIN} 2>/dev/null
iptables -w -X ${DOCKER_CHAIN} 2>/dev/null
ip link del ${DEVICE} 2>/dev/null
exit 0
`;

const UNIT = `[Unit]
Description=Polaris VPN node
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh ${VPN_DIR}/up.sh
ExecStop=/bin/sh ${VPN_DIR}/down.sh

[Install]
WantedBy=multi-user.target
`;

const TOR_UNIT = `[Unit]
Description=Polaris VPN Tor exit
Requires=polaris-vpn.service
After=polaris-vpn.service

[Service]
ExecStartPre=/usr/bin/install -d -o debian-tor -g debian-tor -m 700 /var/lib/polaris-vpn-tor
ExecStart=/usr/bin/tor -f ${VPN_DIR}/torrc --defaults-torrc /dev/null
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

function file(path: string, content: string): string {
    return `cat > '${path}' <<'POLARIS_VPN_EOF'\n${content}POLARIS_VPN_EOF`;
}

/** The peers the node lets in. Keys are checked here as well as where they are made,
 *  since this text ends up in a script run as root. */
export function renderPeers(node: NodePlan, peers: readonly { publicKey: string; host: number }[]): string {
    const blocks = peers.map(({ publicKey, host }) => {
        if (!isWireGuardKey(publicKey)) throw new Error("Not a WireGuard key");
        return `[Peer]\nPublicKey = ${publicKey}\nAllowedIPs = ${deviceAddress(node.index, host)}/32\n`;
    });
    return `#!/bin/sh
set -eu
{
    printf '[Interface]\\nPrivateKey = %s\\nListenPort = ${node.port}\\n' "$(cat ${VPN_DIR}/private.key)"
    cat <<'POLARIS_VPN_PEERS'
${blocks.join("")}POLARIS_VPN_PEERS
} > ${WG_CONFIG}
wg syncconf ${DEVICE} ${WG_CONFIG}
`;
}

/** Everything a node needs, sent as a script and run as root. Run again it changes only
 *  what differs, and the node's key stays, so devices keep working. Answers with the
 *  node's public key. */
export function renderNodeApply(
    node: NodePlan,
    peers: readonly { publicKey: string; host: number }[]
): string {
    const tor = node.exit === "tor";
    return [
        "#!/bin/sh",
        "set -eu",
        "umask 077",
        'need=""',
        "command -v wg >/dev/null 2>&1 || need=\"$need wireguard-tools\"",
        "command -v python3 >/dev/null 2>&1 || need=\"$need python3\"",
        "command -v nft >/dev/null 2>&1 || need=\"$need nftables\"",
        ...(tor ? ['command -v tor >/dev/null 2>&1 || need="$need tor"'] : []),
        'if [ -n "$need" ]; then',
        "    command -v apt-get >/dev/null 2>&1 || { echo unsupported-system; exit 3; }",
        "    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null",
        "    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need >/dev/null",
        "fi",
        `mkdir -p ${VPN_DIR} /etc/wireguard`,
        `id -u ${PROXY_USER} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ${PROXY_USER}`,
        `[ -s ${PROXY_KEY} ] || head -c 32 /dev/urandom | base64 > ${PROXY_KEY}`,
        `chown root:${PROXY_USER} ${PROXY_KEY}`,
        `chmod 640 ${PROXY_KEY}`,
        `[ -s ${VPN_DIR}/private.key ] || wg genkey > ${VPN_DIR}/private.key`,
        file(`${VPN_DIR}/rules.nft`, renderNodeRules(node)),
        file(`${VPN_DIR}/up.sh`, renderUp(node)),
        file(`${VPN_DIR}/down.sh`, DOWN),
        file(`${VPN_DIR}/peers.sh`, renderPeers(node, peers)),
        ...(tor ? [file(`${VPN_DIR}/torrc`, renderTorConfig(node))] : []),
        `nft -c -f ${VPN_DIR}/rules.nft`,
        "umask 022",
        file(PROXY_SCRIPT, renderProxyScript({ tor })),
        file("/etc/systemd/system/polaris-vpn-proxy.service", PROXY_UNIT),
        file("/etc/systemd/system/polaris-vpn.service", UNIT),
        ...(tor ? [file("/etc/systemd/system/polaris-vpn-tor.service", TOR_UNIT)] : []),
        "systemctl daemon-reload",
        "systemctl enable polaris-vpn.service >/dev/null 2>&1",
        "systemctl restart polaris-vpn.service",
        "systemctl enable polaris-vpn-proxy.service >/dev/null 2>&1",
        "systemctl restart polaris-vpn-proxy.service",
        ...(tor
            ? [
                  "systemctl enable polaris-vpn-tor.service >/dev/null 2>&1",
                  "systemctl restart polaris-vpn-tor.service"
              ]
            : [
                  "systemctl disable --now polaris-vpn-tor.service >/dev/null 2>&1 || true",
                  "rm -f /etc/systemd/system/polaris-vpn-tor.service"
              ]),
        `echo "proxy-key=$(cat ${PROXY_KEY})"`,
        `echo "public-key=$(wg pubkey < ${VPN_DIR}/private.key)"`,
        ""
    ].join("\n");
}

/** Change who is let in, leaving every connection that stays as it is. */
export function renderPeerSync(
    node: NodePlan,
    peers: readonly { publicKey: string; host: number }[]
): string {
    return ["#!/bin/sh", "set -eu", "umask 077", "mkdir -p /etc/wireguard", file(`${VPN_DIR}/peers.sh`, renderPeers(node, peers)), `sh ${VPN_DIR}/peers.sh`, ""].join("\n");
}

export const NODE_REMOVE = `#!/bin/sh
! command -v ufw >/dev/null 2>&1 || ufw delete allow ${EDGE_TO_PROXY} >/dev/null 2>&1
systemctl disable --now polaris-vpn-proxy.service polaris-vpn-tor.service polaris-vpn.service >/dev/null 2>&1
rm -f /etc/systemd/system/polaris-vpn.service /etc/systemd/system/polaris-vpn-tor.service /etc/systemd/system/polaris-vpn-proxy.service ${PROXY_SCRIPT} ${PROXY_KEY}
userdel ${PROXY_USER} >/dev/null 2>&1
systemctl daemon-reload
rm -rf ${VPN_DIR} /var/lib/polaris-vpn-tor ${WG_CONFIG}
echo removed
`;

export const NODE_READ = `#!/bin/sh
wg show ${DEVICE} dump 2>/dev/null
`;

export interface PeerCounters {
    readonly publicKey: string;
    readonly lastHandshake: Date | null;
    readonly received: bigint;
    readonly sent: bigint;
}

/** `wg show dump`: the node's own line, then one tab-separated line per peer. Text from
 *  a machine, so anything that does not read as a peer is left out. */
export function parsePeerCounters(output: string): PeerCounters[] {
    return output.split("\n").flatMap((line) => {
        const [publicKey, , , , handshake, received, sent] = line.trim().split("\t");
        if (!publicKey || !isWireGuardKey(publicKey)) return [];
        if (!/^\d+$/.test(handshake ?? "") || !/^\d+$/.test(received ?? "") || !/^\d+$/.test(sent ?? "")) {
            return [];
        }
        const seconds = Number(handshake);
        return [
            {
                publicKey,
                lastHandshake: seconds > 0 ? new Date(seconds * 1000) : null,
                received: BigInt(received ?? 0),
                sent: BigInt(sent ?? 0)
            }
        ];
    });
}

/** What traffic a counter adds since it was last read. A node that restarted counts
 *  from zero again, and then everything it shows is new. */
export function counterGrowth(now: bigint, before: bigint): bigint {
    return now >= before ? now - before : now;
}

export function isPublicEndpoint(endpoint: string): boolean {
    if (!IPV4.test(endpoint)) return true;
    return !/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(endpoint);
}
