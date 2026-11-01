/**
 * Private networks: a subnet of its own for a house's devices, reached through
 * the VPN and independent of the line behind it. Pure: the addressing rules,
 * the gateway's container and the router's setup are asserted in tests, and a
 * client form validates with the same schemas the server does.
 *
 * Devices never join the VPN themselves (a plug cannot run a client). A Polaris
 * server on the same LAN joins it and offers the subnet, and the router keeps the
 * subnet, Wi-Fi name and password fixed whichever line it is plugged into.
 */

import { z } from "zod";
import type { ComposeSpec } from "@polaris/deploy";
import { GATEWAY_PROJECT } from "@/lib/polaris-parts";

/** The most networks one VPN keeps, which also bounds a screen's probes. */
export const MAX_NETWORKS = 16;
export const GATEWAY_SERVICE = "polaris-network-gateway";

const GATEWAY_IMAGE = "tailscale/tailscale:stable";
const GATEWAY_VOLUME = "state";
const GATEWAY_STATE_DIR = "/var/lib/tailscale";

function ipv4ToNumber(address: string): number | null {
    const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
    if (!parts) return null;
    const octets = parts.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return octets.reduce((total, octet) => total * 256 + octet, 0);
}

function numberToIpv4(value: number): string {
    return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

interface Range {
    readonly base: number;
    readonly prefix: number;
    readonly size: number;
}

function rangeOf(cidr: string): Range | null {
    const [address, bits, extra] = cidr.split("/");
    const value = ipv4ToNumber(address ?? "");
    const prefix = /^\d{1,2}$/.test(bits ?? "") ? Number(bits) : Number.NaN;
    if (value === null || extra !== undefined || !(prefix >= 0 && prefix <= 32)) return null;
    const size = 2 ** (32 - prefix);
    return { base: value - (value % size), prefix, size };
}

function contains(outer: string, inner: Range): boolean {
    const range = rangeOf(outer);
    return Boolean(range && inner.base >= range.base && inner.base < range.base + range.size);
}

/** The one spelling of a subnet: the host bits cleared. Input it cannot read is
 *  returned as typed, for the rule to refuse. */
export function normalizeCidr(cidr: string): string {
    const trimmed = cidr.trim();
    const range = rangeOf(trimmed);
    return range ? `${numberToIpv4(range.base)}/${range.prefix}` : trimmed;
}

/**
 * Whether a subnet can be a private network here: a home-sized range of 10.0.0.0/8
 * or 192.168.0.0/16. 172.16.0.0/12 is left out because Docker takes its bridges
 * from it, and a route offered over one would never leave the gateway's container.
 */
export function isUsableCidr(cidr: string): boolean {
    const range = rangeOf(cidr);
    if (!range || range.prefix < 16 || range.prefix > 29) return false;
    return contains("10.0.0.0/8", range) || contains("192.168.0.0/16", range);
}

/** Whether two subnets share any address. */
export function cidrsOverlap(first: string, second: string): boolean {
    const a = rangeOf(first);
    const b = rangeOf(second);
    if (!a || !b) return false;
    return a.base < b.base + b.size && b.base < a.base + a.size;
}

/** Whether `address` is a host of `cidr`: inside it, and neither of its two ends. */
export function isHostOf(cidr: string, address: string): boolean {
    const range = rangeOf(cidr);
    const value = ipv4ToNumber(address);
    if (!range || value === null) return false;
    return value > range.base && value < range.base + range.size - 1;
}

/** The address a router of `cidr` usually takes: its first host. */
export function firstHost(cidr: string): string {
    const range = rangeOf(cidr);
    return range ? numberToIpv4(range.base + 1) : "";
}

/** The first /24 of 10.77.0.0/16 no network uses, offered in the form. Far from the
 *  192.168.x.x every operator's router hands out, so a new line never collides. */
export function suggestCidr(taken: readonly string[]): string {
    for (let block = 0; block < 256; block += 1) {
        const cidr = `10.77.${block}.0/24`;
        if (!taken.some((other) => cidrsOverlap(cidr, other))) return cidr;
    }
    return "";
}

/** The most a Wi-Fi name can hold, in bytes rather than characters. */
const SSID_MAX_BYTES = 32;

function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
}

/** The longest start of `name` a Wi-Fi name can hold, never cutting a character. */
export function ssidFrom(name: string): string {
    let fitted = "";
    for (const character of name) {
        if (byteLength(fitted + character) > SSID_MAX_BYTES) break;
        fitted += character;
    }
    return fitted;
}

/** The fields a person types, shared by the form and the action. */
export const networkInputSchema = z
    .object({
        name: z.string().trim().min(1).max(40),
        cidr: z.string().transform(normalizeCidr).pipe(z.string().refine(isUsableCidr)),
        routerAddress: z.string().trim(),
        targetId: z.string().trim().min(1).max(64),
        ssid: z
            .string()
            .trim()
            .min(1)
            .refine((ssid) => byteLength(ssid) <= SSID_MAX_BYTES),
        access: z.enum(["admins", "everyone"]),
        internet: z.boolean()
    })
    .refine((input) => isHostOf(input.cidr, input.routerAddress), { path: ["routerAddress"] });
export type NetworkInput = z.infer<typeof networkInputSchema>;

/** What can change once a network exists; its subnet and server stay. */
export const networkChangeSchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(40),
    access: z.enum(["admins", "everyone"]),
    internet: z.boolean()
});
export type NetworkChange = z.infer<typeof networkChangeSchema>;

const storedNetworkSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    cidr: z.string().refine(isUsableCidr),
    routerAddress: z.string().min(1),
    targetId: z.string().min(1),
    /** Who owns the server, whose access reaches it. */
    targetOwnerId: z.string().min(1),
    ssid: z.string().min(1),
    /** The Wi-Fi password, sealed with the master key. */
    wifiPassword: z.string().min(1),
    access: z.enum(["admins", "everyone"]),
    internet: z.boolean(),
    createdAt: z.string()
});
export type PrivateNetwork = z.infer<typeof storedNetworkSchema>;

/** The networks on a settings row, one by one, so a row an older Polaris wrote
 *  loses only what it cannot read and never the rest. */
export function readNetworks(stored: unknown): PrivateNetwork[] {
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((entry) => {
        const parsed = storedNetworkSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

/** The subnets every member may reach; administrators reach all of them already. */
export function sharedCidrs(networks: readonly PrivateNetwork[]): string[] {
    return networks.filter((network) => network.access === "everyone").map(({ cidr }) => cidr);
}

/** The name a server's gateway signs in as: stable, so it is found again. */
export function gatewayName(targetId: string): string {
    const short = targetId
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 12);
    return `polaris-gateway-${short}`;
}

/** Whether a VPN device is the gateway of `name`. Its hostname is what the gateway
 *  reports and survives a rename on the Devices screen; the given name is what
 *  Headscale suffixes when a name is taken, as it is after a state volume is lost. */
export function isGatewayNode(
    node: {
        readonly name: string;
        readonly givenName: string;
        readonly tags: readonly string[];
    },
    name: string,
    tag: string
): boolean {
    if (!node.tags.includes(tag)) return false;
    return (
        node.name === name || node.givenName === name || node.givenName.startsWith(`${name}-`)
    );
}

/** Empty the state for a generation not seen yet, then start as usual. One line:
 *  the host daemon refuses a command argument holding a control character. */
const GATEWAY_BOOT = [
    `marker=${GATEWAY_STATE_DIR}/.polaris-generation`,
    `if [ -n "$POLARIS_GENERATION" ] && ! grep -qx "$POLARIS_GENERATION" "$marker" 2>/dev/null; then find ${GATEWAY_STATE_DIR} -mindepth 1 -delete`,
    'echo "$POLARIS_GENERATION" > "$marker"',
    "fi",
    "exec /usr/local/bin/containerboot"
].join("; ");

/**
 * The gateway's container on one server. Userspace, like remote access: no device
 * and no capabilities, and the host's own routing carries its traffic to the LAN,
 * so it runs on any server and leaves that server's firewall alone.
 *
 * `TS_AUTH_ONCE`: the state volume keeps it signed in, so a later change of routes
 * never needs a new key, and an expired one is not an error, including on a reboot.
 *
 * That same state would keep a gateway out for good once its device is gone from
 * the VPN: it holds a sign-in the control server no longer knows, and never uses
 * its new key. So `generation` is set when the device is missing, and a container
 * that has not seen that value yet starts from empty state. The value is written
 * beside the state, so a reboot with the same environment wipes nothing.
 */
export function gatewaySpec(input: {
    readonly name: string;
    readonly loginServer: string;
    readonly routes: readonly string[];
    readonly authKey: string;
    readonly generation: string | null;
}): ComposeSpec {
    return {
        project: GATEWAY_PROJECT,
        services: [
            {
                name: GATEWAY_SERVICE,
                image: GATEWAY_IMAGE,
                pullPolicy: "always",
                env: {
                    TS_STATE_DIR: GATEWAY_STATE_DIR,
                    TS_USERSPACE: "true",
                    TS_AUTH_ONCE: "true",
                    TS_ACCEPT_DNS: "false",
                    TS_HOSTNAME: input.name,
                    TS_ROUTES: input.routes.join(","),
                    TS_AUTHKEY: input.authKey,
                    TS_EXTRA_ARGS: `--login-server=${input.loginServer}`,
                    POLARIS_GENERATION: input.generation ?? ""
                },
                entrypoint: ["/bin/sh", "-c", GATEWAY_BOOT],
                ports: [],
                volumes: [{ source: GATEWAY_VOLUME, target: GATEWAY_STATE_DIR, kind: "volume" }],
                labels: {},
                networks: [],
                restart: "unless-stopped",
                memoryMb: 256
            }
        ],
        volumes: [GATEWAY_VOLUME],
        networks: []
    };
}

/** A value inside single quotes in a shell script. */
function shellQuoted(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The DHCP pool a router of `cidr` hands out: upper half, at most 150 addresses. */
export function dhcpPool(cidr: string): { start: number; limit: number } {
    const range = rangeOf(cidr);
    const hosts = range ? range.size - 2 : 0;
    const start = hosts >= 254 ? 100 : Math.floor(hosts / 2) + 1;
    return { start, limit: Math.min(150, hosts - start) };
}

/** The addresses of `dhcpPool`, for typing into a router that asks for them. */
export function dhcpRange(cidr: string): { first: string; last: string } {
    const base = rangeOf(cidr)?.base ?? 0;
    const { start, limit } = dhcpPool(cidr);
    return { first: numberToIpv4(base + start), last: numberToIpv4(base + start + limit - 1) };
}

function sectionId(networkId: string): string {
    return `pn${networkId.replace(/-/g, "").slice(0, 6)}`;
}

/** The bridge the OpenWrt setup creates for a network. */
export function bridgeName(networkId: string): string {
    return `br-${sectionId(networkId)}`;
}

function netmaskOf(prefix: number): string {
    return numberToIpv4(2 ** 32 - 2 ** (32 - prefix));
}

/**
 * An OpenWrt script that creates the network: a bridge, its address and DHCP, a
 * firewall zone nothing inside can leave, and the Wi-Fi on every radio. The LAN
 * (where the Polaris server sits) may enter; the devices start nothing outward
 * unless the network is allowed internet. Safe to run again: it replaces its own
 * sections, so it is also how a replacement router gets the same network.
 *
 * The bridge stays up with nothing on it, so the router's address exists on a router
 * with no radio. Which cable port to give it is the router owner's choice: the
 * screen names the bridge. A radio that was off is turned on with its other Wi-Fi
 * networks turned off, because a factory image's default network is open.
 */
export function renderOpenWrtSetup(network: PrivateNetwork, wifiPassword: string): string {
    const id = sectionId(network.id);
    const bridge = bridgeName(network.id);
    const pool = dhcpPool(network.cidr);
    const sections = ["", "_dev"].map((end) => `network.${id}${end}`);
    const firewall = ["", "_dhcp", "_dns", "_lan", "_wan"].map((end) => `firewall.${id}${end}`);
    return [
        "#!/bin/sh",
        `# Polaris private network: ${network.name.replace(/[\r\n]+/g, " ")}`,
        "set -e",
        ...[...sections, `dhcp.${id}`, ...firewall].map(
            (section) => `uci -q delete ${section} || true`
        ),
        `uci set network.${id}_dev=device`,
        `uci set network.${id}_dev.type='bridge'`,
        `uci set network.${id}_dev.name='${bridge}'`,
        `uci set network.${id}_dev.bridge_empty='1'`,
        `uci set network.${id}=interface`,
        `uci set network.${id}.proto='static'`,
        `uci set network.${id}.device='${bridge}'`,
        `uci set network.${id}.ipaddr=${shellQuoted(network.routerAddress)}`,
        `uci set network.${id}.netmask=${shellQuoted(netmaskOf(rangeOf(network.cidr)?.prefix ?? 24))}`,
        `uci set dhcp.${id}=dhcp`,
        `uci set dhcp.${id}.interface='${id}'`,
        `uci set dhcp.${id}.start='${pool.start}'`,
        `uci set dhcp.${id}.limit='${pool.limit}'`,
        `uci set dhcp.${id}.leasetime='12h'`,
        `uci set firewall.${id}=zone`,
        `uci set firewall.${id}.name='${id}'`,
        `uci add_list firewall.${id}.network='${id}'`,
        `uci set firewall.${id}.input='REJECT'`,
        `uci set firewall.${id}.output='ACCEPT'`,
        `uci set firewall.${id}.forward='REJECT'`,
        `uci set firewall.${id}_dhcp=rule`,
        `uci set firewall.${id}_dhcp.name='${id}-dhcp'`,
        `uci set firewall.${id}_dhcp.src='${id}'`,
        `uci set firewall.${id}_dhcp.proto='udp'`,
        `uci set firewall.${id}_dhcp.dest_port='67-68'`,
        `uci set firewall.${id}_dhcp.target='ACCEPT'`,
        `uci set firewall.${id}_dns=rule`,
        `uci set firewall.${id}_dns.name='${id}-dns'`,
        `uci set firewall.${id}_dns.src='${id}'`,
        `uci add_list firewall.${id}_dns.proto='tcp'`,
        `uci add_list firewall.${id}_dns.proto='udp'`,
        `uci set firewall.${id}_dns.dest_port='53'`,
        `uci set firewall.${id}_dns.target='ACCEPT'`,
        `uci set firewall.${id}_lan=forwarding`,
        `uci set firewall.${id}_lan.src='lan'`,
        `uci set firewall.${id}_lan.dest='${id}'`,
        ...(network.internet
            ? [
                  `uci set firewall.${id}_wan=forwarding`,
                  `uci set firewall.${id}_wan.src='${id}'`,
                  `uci set firewall.${id}_wan.dest='wan'`
              ]
            : []),
        // A router with no radio (a Raspberry Pi on a cable, say) has no file to edit.
        "if [ -f /etc/config/wireless ]; then",
        `    for radio in $(uci show wireless | sed -n "s/^wireless\\.\\([^.=]*\\)=wifi-device$/\\1/p"); do`,
        `        section="${id}_$radio"`,
        '        uci -q delete "wireless.$section" || true',
        '        if [ "$(uci -q get "wireless.$radio.disabled")" = "1" ]; then',
        `            for iface in $(uci show wireless | sed -n "s/^wireless\\.\\([^.=]*\\)\\.device='$radio'$/\\1/p"); do`,
        '                uci set "wireless.$iface.disabled=1"',
        "            done",
        '            uci delete "wireless.$radio.disabled"',
        "        fi",
        '        uci set "wireless.$section=wifi-iface"',
        '        uci set "wireless.$section.device=$radio"',
        `        uci set "wireless.$section.network=${id}"`,
        '        uci set "wireless.$section.mode=ap"',
        `        uci set "wireless.$section.ssid="${shellQuoted(network.ssid)}`,
        '        uci set "wireless.$section.encryption=psk2"',
        `        uci set "wireless.$section.key="${shellQuoted(wifiPassword)}`,
        "    done",
        "    uci commit wireless",
        "fi",
        "uci commit network",
        "uci commit dhcp",
        "uci commit firewall",
        "service network reload",
        "service dnsmasq restart",
        "service firewall restart",
        "[ -f /etc/config/wireless ] && wifi reload || true",
        ""
    ].join("\n");
}
