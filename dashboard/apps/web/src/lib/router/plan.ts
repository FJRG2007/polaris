/**
 * A Linux machine as this network's router: what the operator decides, and the files
 * that make the machine do it. Pure, so the form validates with the same schema as
 * the server and everything sent to a machine is asserted in tests.
 *
 * Line failover moves one default route in a table of its own rather than marking
 * packets, so it does not fight a VPN client on the same machine, which is what stops
 * a multi-WAN package from sharing a router with one. The table sits ahead of the
 * machine's own default routes, whatever metric they were given.
 */

import { z } from "zod";
import { cidrsOverlap, dhcpRange, isHostOf, isUsableCidr, normalizeCidr } from "@/lib/vpn/networks";

export const ROUTER_DIR = "/etc/polaris-router";
export const ROUTER_STATE_DIR = "/var/lib/polaris-router";
/** How long a change has to be confirmed before the machine undoes it. */
export const ROLLBACK_SECONDS = 120;
export const MAX_LANS = 16;
export const MAX_WANS = 4;
export const MAX_FORWARDS = 64;
export const MAX_RESERVATIONS = 256;
/** The routing table that holds the line in use. */
const ROUTE_TABLE = 7100;

/** Up to Linux's 15: a USB adapter is named after its MAC, as enx00e04c680001. */
const INTERFACE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,14}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const interfaceName = z.string().trim().regex(INTERFACE);
const ipv4 = z.string().trim().regex(IPV4);
const vlan = z.number().int().min(2).max(4094).nullable();
const port = z.number().int().min(1).max(65535);

/** One way out to the internet, tried in list order. */
export const wanSchema = z.object({ interface: interfaceName, vlan });
export type RouterWan = z.infer<typeof wanSchema>;

export const reservationSchema = z.object({
    mac: z.string().trim().toLowerCase().regex(MAC),
    address: ipv4
});

/** One network of devices behind the router. */
export const lanSchema = z
    .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(40),
        interface: interfaceName,
        vlan,
        cidr: z.string().transform(normalizeCidr).pipe(z.string().refine(isUsableCidr)),
        address: ipv4,
        internet: z.boolean(),
        /** Devices here reach no other network behind this router. */
        isolated: z.boolean(),
        reservations: z.array(reservationSchema).max(MAX_RESERVATIONS)
    })
    .refine((lan) => isHostOf(lan.cidr, lan.address), { path: ["address"] })
    .refine((lan) => lan.reservations.every(({ address }) => isHostOf(lan.cidr, address)), {
        path: ["reservations"]
    });
export type RouterLan = z.infer<typeof lanSchema>;

export const forwardSchema = z.object({
    protocol: z.enum(["tcp", "udp"]),
    port,
    address: ipv4,
    toPort: port
});
export type RouterForward = z.infer<typeof forwardSchema>;

/** The most a Linux network device's name can hold. */
const DEVICE_NAME_MAX = 15;

/** A VLAN's device. `port.20`, unless that is too long for Linux, as it is on a USB
 *  adapter: the end of the port's name is what tells two of them apart. */
export function deviceOf(link: { interface: string; vlan: number | null }): string {
    if (link.vlan === null) return link.interface;
    const name = `${link.interface}.${link.vlan}`;
    if (name.length <= DEVICE_NAME_MAX) return name;
    return `v${link.vlan}.${link.interface.slice(-(DEVICE_NAME_MAX - `v${link.vlan}.`.length))}`;
}

function sameValues(values: readonly string[]): boolean {
    return new Set(values).size !== values.length;
}

/** Everything the operator decides about one router. */
export const routerPlanSchema = z
    .object({
        wans: z.array(wanSchema).min(1).max(MAX_WANS),
        lans: z.array(lanSchema).min(1).max(MAX_LANS),
        forwards: z.array(forwardSchema).max(MAX_FORWARDS)
    })
    .superRefine((plan, issue) => {
        const devices = [...plan.wans, ...plan.lans].map(deviceOf);
        if (sameValues(devices)) {
            issue.addIssue({ code: "custom", path: ["lans"], message: "sharedPort" });
        }
        const overlapping = plan.lans.some((lan, at) =>
            plan.lans.slice(at + 1).some((other) => cidrsOverlap(lan.cidr, other.cidr))
        );
        if (overlapping) issue.addIssue({ code: "custom", path: ["lans"], message: "overlap" });
        const opened = plan.forwards.map(({ protocol, port: open }) => `${protocol}/${open}`);
        if (sameValues(opened)) {
            issue.addIssue({ code: "custom", path: ["forwards"], message: "samePort" });
        }
        const inside = plan.forwards.every(({ address }) =>
            plan.lans.some((lan) => isHostOf(lan.cidr, address))
        );
        if (!inside) issue.addIssue({ code: "custom", path: ["forwards"], message: "outside" });
    });
export type RouterPlan = z.infer<typeof routerPlanSchema>;

/** A stored plan, or null: a row older than this code must not break the screen. */
export function readPlan(stored: unknown): RouterPlan | null {
    const parsed = routerPlanSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
}

/** Where the machine stands while the plan is applied and read. */
export interface RouterAccess {
    /** The address Polaris connects from, kept open from the internet side. */
    readonly management: string | null;
    readonly sshPort: number;
}

function quotedList(values: readonly string[]): string {
    return `{ ${values.map((value) => `"${value}"`).join(", ")} }`;
}

/** The firewall: nothing enters from a line unless it was asked for, and the access
 *  Polaris is using stays open so a change cannot lock it out. Traffic of containers
 *  on the machine is left to the rules their engine writes. */
export function renderFirewall(plan: RouterPlan, access: RouterAccess): string {
    const wans = plan.wans.map(deviceOf);
    const lans = plan.lans.map(deviceOf);
    const open = plan.lans.filter((lan) => !lan.isolated).map(deviceOf);
    const online = plan.lans.filter((lan) => lan.internet).map(deviceOf);
    const closed = plan.lans.filter((lan) => lan.isolated).map(deviceOf);
    const engine = 'iifname { "docker0", "br-*", "tailscale0" } accept';
    const toEngine = 'oifname { "docker0", "br-*", "tailscale0" } accept';
    const managed = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];
    return [
        "table inet polaris_router {}",
        "delete table inet polaris_router",
        "table inet polaris_router {",
        "    chain input {",
        "        type filter hook input priority filter; policy drop;",
        "        ct state established,related accept",
        "        ct state invalid drop",
        '        iifname "lo" accept',
        "        ip protocol icmp accept",
        "        ip6 nexthdr icmpv6 accept",
        `        iifname ${quotedList(lans)} udp dport { 53, 67 } accept`,
        `        iifname ${quotedList(lans)} tcp dport 53 accept`,
        ...(access.management
            ? [`        ip saddr ${access.management} tcp dport ${access.sshPort} accept`]
            : []),
        ...(closed.length > 0
            ? [`        iifname ${quotedList(closed)} tcp dport ${access.sshPort} drop`]
            : []),
        `        ip saddr { ${managed.join(", ")} } tcp dport ${access.sshPort} accept`,
        `        ${engine}`,
        "    }",
        "    chain forward {",
        "        type filter hook forward priority filter; policy drop;",
        "        ct state established,related accept",
        "        ct state invalid drop",
        "        ct status dnat accept",
        `        ${engine}`,
        `        ${toEngine}`,
        ...(online.length > 0
            ? [`        iifname ${quotedList(online)} oifname ${quotedList(wans)} accept`]
            : []),
        ...(open.length > 1
            ? [`        iifname ${quotedList(open)} oifname ${quotedList(open)} accept`]
            : []),
        "    }",
        "    chain incoming {",
        "        type nat hook prerouting priority dstnat; policy accept;",
        ...plan.forwards.map(
            (forward) =>
                `        iifname ${quotedList(wans)} ${forward.protocol} dport ${forward.port} dnat ip to ${forward.address}:${forward.toPort}`
        ),
        "    }",
        "    chain outgoing {",
        "        type nat hook postrouting priority srcnat; policy accept;",
        `        oifname ${quotedList(wans)} masquerade`,
        "    }",
        "}",
        ""
    ].join("\n");
}

/** DHCP and DNS for the networks, as a service of its own so it never takes the
 *  machine's own name resolution or a DNS server already there. */
export function renderDnsmasq(plan: RouterPlan): string {
    const lines = [
        "port=53",
        "bind-interfaces",
        "except-interface=lo",
        "no-hosts",
        "dhcp-authoritative",
        `dhcp-leasefile=${ROUTER_STATE_DIR}/leases`,
        "dhcp-rapid-commit",
        "server=1.1.1.1",
        "server=9.9.9.9",
        "no-resolv"
    ];
    for (const lan of plan.lans) {
        const device = deviceOf(lan);
        const { first, last } = dhcpRange(lan.cidr);
        lines.push(
            `interface=${device}`,
            `dhcp-range=set:${device},${first},${last},12h`,
            `dhcp-option=tag:${device},option:router,${lan.address}`,
            `dhcp-option=tag:${device},option:dns-server,${lan.address}`
        );
        for (const { mac, address } of lan.reservations) {
            lines.push(`dhcp-host=${mac},${address}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

function shellWords(values: readonly string[]): string {
    return values.join(" ");
}

/** Bring the networks up. Run again on every boot and every change, so each step
 *  has to hold when it is already done. */
export function renderUp(plan: RouterPlan): string {
    const lines = [
        "#!/bin/sh",
        "set -eu",
        "sysctl -q -w net.ipv4.ip_forward=1",
        `ip rule del priority ${ROUTE_TABLE} 2>/dev/null || true`,
        `ip rule del priority ${ROUTE_TABLE + 1} 2>/dev/null || true`,
        `ip rule add priority ${ROUTE_TABLE} lookup main suppress_prefixlength 0`,
        `ip rule add priority ${ROUTE_TABLE + 1} lookup ${ROUTE_TABLE}`
    ];
    const vlans = [...plan.wans, ...plan.lans].filter((link) => link.vlan !== null);
    for (const link of vlans) {
        lines.push(
            `ip link set ${link.interface} up`,
            `ip link show ${deviceOf(link)} >/dev/null 2>&1 || ip link add link ${link.interface} name ${deviceOf(link)} type vlan id ${link.vlan}`
        );
    }
    for (const lan of plan.lans) {
        const device = deviceOf(lan);
        const prefix = lan.cidr.split("/")[1];
        lines.push(
            `! command -v nmcli >/dev/null 2>&1 || nmcli device set ${device} managed no >/dev/null 2>&1 || true`,
            `ip link set ${device} up`,
            `ip addr flush dev ${device}`,
            `ip addr add ${lan.address}/${prefix} dev ${device}`
        );
    }
    for (const wan of plan.wans) {
        lines.push(
            `ip link set ${deviceOf(wan)} up`,
            `sysctl -q -w net.ipv4.conf.${deviceOf(wan).replace(".", "/")}.rp_filter=2`
        );
    }
    lines.push(`nft -f ${ROUTER_DIR}/rules.nft`, "");
    return lines.join("\n");
}

/** Undo `renderUp`, leaving the machine as an ordinary one. */
export function renderDown(plan: RouterPlan): string {
    const lines = [
        "#!/bin/sh",
        "nft delete table inet polaris_router 2>/dev/null",
        `ip rule del priority ${ROUTE_TABLE} 2>/dev/null`,
        `ip rule del priority ${ROUTE_TABLE + 1} 2>/dev/null`,
        `ip route flush table ${ROUTE_TABLE} 2>/dev/null`
    ];
    for (const lan of plan.lans) {
        lines.push(`ip addr flush dev ${deviceOf(lan)} 2>/dev/null`);
        lines.push(
            `! command -v nmcli >/dev/null 2>&1 || nmcli device set ${deviceOf(lan)} managed yes >/dev/null 2>&1`
        );
    }
    for (const link of [...plan.wans, ...plan.lans]) {
        if (link.vlan !== null) lines.push(`ip link del ${deviceOf(link)} 2>/dev/null`);
    }
    lines.push("exit 0", "");
    return lines.join("\n");
}

/**
 * Keep the default route on the first line that works. A line is dropped after three
 * failed rounds and taken back after six good ones, so a blip neither moves every
 * connection nor makes the route flap.
 */
export function renderWanWatch(plan: RouterPlan): string {
    return `#!/bin/sh
WANS="${shellWords(plan.wans.map(deviceOf))}"
HOSTS="1.1.1.1 9.9.9.9"
TABLE=${ROUTE_TABLE}
STATE=/run/polaris-router
mkdir -p "$STATE"
alive() {
    for host in $HOSTS; do
        ping -n -c 1 -W 2 -I "$1" "$host" >/dev/null 2>&1 && return 0
    done
    return 1
}
gateway() {
    ip -4 route show default dev "$1" | awk '/via/ { print $3; exit }'
}
current=""
bad=0
good=0
while :; do
    best=""
    for wan in $WANS; do
        if [ -n "$(gateway "$wan")" ] && alive "$wan"; then best=$wan; break; fi
    done
    if [ -z "$current" ]; then
        target=$best
    elif [ "$best" = "$current" ]; then
        target=$current
        bad=0
        good=0
    else
        target=$current
        rank_best=99
        rank_current=99
        at=0
        for wan in $WANS; do
            at=$((at + 1))
            [ "$wan" = "$best" ] && rank_best=$at
            [ "$wan" = "$current" ] && rank_current=$at
        done
        if [ -n "$best" ] && [ "$rank_best" -lt "$rank_current" ] && alive "$current"; then
            good=$((good + 1))
            [ "$good" -ge 6 ] && target=$best
        else
            bad=$((bad + 1))
            [ "$bad" -ge 3 ] && target=$best
        fi
    fi
    if [ -n "$target" ] && [ "$target" != "$current" ]; then
        via=$(gateway "$target")
        if [ -n "$via" ] && ip route replace default via "$via" dev "$target" table $TABLE; then
            ! command -v conntrack >/dev/null 2>&1 || conntrack -F >/dev/null 2>&1
            current=$target
            bad=0
            good=0
        fi
    elif [ -n "$current" ]; then
        via=$(gateway "$current")
        [ -z "$via" ] || ip route replace default via "$via" dev "$current" table $TABLE
    fi
    printf '%s\\n' "$current" > "$STATE/wan"
    sleep 5
done
`;
}

const UNITS: Record<string, string> = {
    "polaris-router.service": `[Unit]
Description=Polaris router networks
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh ${ROUTER_DIR}/up.sh
ExecStop=/bin/sh ${ROUTER_DIR}/down.sh

[Install]
WantedBy=multi-user.target
`,
    "polaris-router-dns.service": `[Unit]
Description=Polaris router addresses and names
Requires=polaris-router.service
After=polaris-router.service

[Service]
ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file=${ROUTER_DIR}/dnsmasq.conf
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`,
    "polaris-router-wan.service": `[Unit]
Description=Polaris router line failover
Requires=polaris-router.service
After=polaris-router.service

[Service]
ExecStart=/bin/sh ${ROUTER_DIR}/wan-watch.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`
};

const SERVICES = Object.keys(UNITS);
const SERVICE_LIST = SERVICES.join(" ");

/** The packages a router needs, installed before the network is touched. */
const INSTALL = `need=""
command -v nft >/dev/null 2>&1 || need="$need nftables"
[ -x /usr/sbin/dnsmasq ] || need="$need dnsmasq-base"
command -v ping >/dev/null 2>&1 || need="$need iputils-ping"
command -v conntrack >/dev/null 2>&1 || need="$need conntrack"
if [ -n "$need" ]; then
    command -v apt-get >/dev/null 2>&1 || { echo unsupported-system; exit 3; }
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need >/dev/null
fi`;

function heredoc(path: string, content: string): string {
    return `cat > '${path}' <<'POLARIS_ROUTER_EOF'\n${content}POLARIS_ROUTER_EOF`;
}

/** Stop what runs, leaving the machine reachable by whatever it had before. */
const STOP_ALL = `systemctl stop ${SERVICE_LIST} 2>/dev/null
[ ! -f ${ROUTER_DIR}/down.sh ] || /bin/sh ${ROUTER_DIR}/down.sh`;

/** Turn on what is in the directory, or nothing when there is no directory. */
const START_ALL = `systemctl daemon-reload
if [ -f ${ROUTER_DIR}/up.sh ]; then
    systemctl enable ${SERVICE_LIST} >/dev/null 2>&1
    systemctl restart ${SERVICE_LIST}
else
    systemctl disable ${SERVICE_LIST} >/dev/null 2>&1
    true
fi`;

/**
 * Everything one change does, sent as a script and run as root. The network changes
 * in a detached unit, because the connection delivering this may be the first thing
 * it cuts. A timer undoes the change unless Polaris comes back and confirms it, so a
 * wrong port leaves a working machine and not one somebody has to go and plug a
 * screen into.
 */
export function renderApply(plan: RouterPlan, access: RouterAccess): string {
    const next = `${ROUTER_DIR}.next`;
    const previous = `${ROUTER_DIR}.previous`;
    const files: Record<string, string> = {
        "rules.nft": renderFirewall(plan, access),
        "dnsmasq.conf": renderDnsmasq(plan),
        "up.sh": renderUp(plan),
        "down.sh": renderDown(plan),
        "wan-watch.sh": renderWanWatch(plan)
    };
    const activate = `#!/bin/sh
${STOP_ALL}
rm -rf ${previous}
[ ! -d ${ROUTER_DIR} ] || mv ${ROUTER_DIR} ${previous}
mv ${next} ${ROUTER_DIR}
${START_ALL}
`;
    const rollback = `#!/bin/sh
${STOP_ALL}
rm -rf ${ROUTER_DIR}
[ ! -d ${previous} ] || mv ${previous} ${ROUTER_DIR}
${START_ALL}
echo rolled-back > ${ROUTER_STATE_DIR}/last
`;
    return [
        "#!/bin/sh",
        "set -eu",
        INSTALL,
        `mkdir -p ${ROUTER_STATE_DIR}`,
        `rm -rf ${next}`,
        `mkdir -p ${next}`,
        ...Object.entries(files).map(([name, content]) => heredoc(`${next}/${name}`, content)),
        ...Object.entries(UNITS).map(([name, content]) =>
            heredoc(`/etc/systemd/system/${name}`, content)
        ),
        heredoc(`${ROUTER_STATE_DIR}/activate.sh`, activate),
        heredoc(`${ROUTER_STATE_DIR}/rollback.sh`, rollback),
        `nft -c -f ${next}/rules.nft`,
        `/usr/sbin/dnsmasq --test --conf-file=${next}/dnsmasq.conf >/dev/null 2>&1`,
        `rm -f ${ROUTER_STATE_DIR}/last`,
        "systemctl stop polaris-router-rollback.timer polaris-router-rollback.service polaris-router-activate.timer polaris-router-activate.service 2>/dev/null || true",
        "systemctl reset-failed polaris-router-rollback.service polaris-router-activate.service 2>/dev/null || true",
        `systemd-run --quiet --unit=polaris-router-rollback --timer-property=AccuracySec=1s --on-active=${ROLLBACK_SECONDS} /bin/sh ${ROUTER_STATE_DIR}/rollback.sh`,
        `systemd-run --quiet --unit=polaris-router-activate --timer-property=AccuracySec=1s --on-active=2 /bin/sh ${ROUTER_STATE_DIR}/activate.sh`,
        "echo accepted",
        ""
    ].join("\n");
}

/** Keep the change: whoever runs this came back through the new network. Answers
 *  `confirmed` only when the router is really up, and a change that failed to start
 *  is undone now rather than when the timer runs out. */
export const CONFIRM_SCRIPT = `#!/bin/sh
[ ! -f ${ROUTER_STATE_DIR}/last ] || { cat ${ROUTER_STATE_DIR}/last; exit 0; }
if systemctl is-failed --quiet polaris-router.service; then
    systemctl stop polaris-router-rollback.timer 2>/dev/null
    /bin/sh ${ROUTER_STATE_DIR}/rollback.sh >/dev/null 2>&1
    cat ${ROUTER_STATE_DIR}/last
    exit 0
fi
systemctl is-active --quiet polaris-router.service || { echo waiting; exit 0; }
systemctl is-active --quiet polaris-router-dns.service || { echo waiting; exit 0; }
systemctl stop polaris-router-rollback.timer 2>/dev/null
echo confirmed
`;

/** Make the machine an ordinary one again. */
export const REMOVE_SCRIPT = `#!/bin/sh
systemctl stop polaris-router-rollback.timer 2>/dev/null
${STOP_ALL}
systemctl disable ${SERVICE_LIST} >/dev/null 2>&1
rm -rf ${ROUTER_DIR} ${ROUTER_DIR}.next ${ROUTER_DIR}.previous
rm -f ${SERVICES.map((name) => `/etc/systemd/system/${name}`).join(" ")}
systemctl daemon-reload
echo removed
`;

/** Read the machine's ports and what they hold, without changing anything. */
export const PROBE_SCRIPT = `#!/bin/sh
echo "---links"
ip -j link show 2>/dev/null || echo '[]'
echo "---addresses"
ip -j -4 addr show 2>/dev/null || echo '[]'
echo "---routes"
ip -j -4 route show default 2>/dev/null || echo '[]'
echo "---client"
printf '%s\\n' "\${SSH_CLIENT%% *}"
echo "---wan"
cat /run/polaris-router/wan 2>/dev/null
echo "---services"
for unit in ${SERVICE_LIST}; do systemctl is-active "$unit" 2>/dev/null; done
echo "---leases"
cat ${ROUTER_STATE_DIR}/leases 2>/dev/null
echo "---counters"
ip -j -s link show 2>/dev/null || echo '[]'
echo "---last"
cat ${ROUTER_STATE_DIR}/last 2>/dev/null
echo "---end"
`;
