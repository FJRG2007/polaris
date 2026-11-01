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
/** The most leases read from a machine: a /16 can hold far more than a screen can use. */
export const MAX_CLIENTS = 2000;
/** The routing table that holds the line in use. */
const ROUTE_TABLE = 7100;
/** Marks a change the machine is still running on approval. */
const UNCONFIRMED = `${ROUTER_STATE_DIR}/unconfirmed`;
/** Names the change the machine finished starting. */
const APPLIED = `${ROUTER_STATE_DIR}/applied`;
/** The answer a machine leaves once it has gone back. */
const LAST = `${ROUTER_STATE_DIR}/last`;
/** Above an ordinary interface's default route, so a line's lease never collides. */
const LINE_METRIC = 300;
/** Where a machine's own firewall has to be told about a router, when Docker runs. */
const DOCKER_ALLOW_CHAIN = "POLARIS-ROUTER";

/** Up to Linux's 15: a USB adapter is named after its MAC, as enx00e04c680001. */
const INTERFACE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,14}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const interfaceName = z.string().trim().regex(INTERFACE, "badPort");
const ipv4 = z.string().trim().regex(IPV4);
const vlan = z.number().int("badVlan").min(2, "badVlan").max(4094, "badVlan").nullable();
const port = z.number().int().min(1).max(65535);

/** Whether a machine's port can be used in a plan. */
export function isPortName(name: string): boolean {
    return INTERFACE.test(name);
}

/** A network's id, from a source a plain-http page has too: `crypto.randomUUID` needs
 *  a secure context, and a router's own screen is often reached without one. */
export function newLanId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** The setting that holds a machine's plan. */
export function routerPlanKey(hostId: string): string {
    return `router.plan.${hostId}`;
}

/** One way out to the internet, tried in list order. */
export const wanSchema = z.object({ interface: interfaceName, vlan });
export type RouterWan = z.infer<typeof wanSchema>;

export const reservationSchema = z.object({
    mac: z.string().trim().toLowerCase().regex(MAC),
    address: ipv4
});

/** Whether a fixed address can be handed out: inside the subnet, not the router's own,
 *  and the only claim on its address and device. The DHCP server refuses to start on
 *  a repeated one, and no retry would ever get past that. */
export function reservationFits(
    lan: { cidr: string; address: string },
    all: readonly { mac: string; address: string }[],
    one: { mac: string; address: string }
): boolean {
    const mac = one.mac.trim().toLowerCase();
    const address = one.address.trim();
    return (
        isHostOf(lan.cidr, address) &&
        address !== lan.address.trim() &&
        all.filter((other) => other.address.trim() === address).length === 1 &&
        all.filter((other) => other.mac.trim().toLowerCase() === mac).length === 1
    );
}

/** One network as a stored plan may hold it: a row saved under older rules still has
 *  to reach the screen, since that is the only way to correct or stop that router. */
const storedLanSchema = z
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

/** One network of devices behind the router. */
export const lanSchema = storedLanSchema.refine(
    (lan) => lan.reservations.every((one) => reservationFits(lan, lan.reservations, one)),
    { path: ["reservations"], message: "badReservation" }
);
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

const wansSchema = z.array(wanSchema).min(1, "noLine").max(MAX_WANS);
const forwardsSchema = z.array(forwardSchema).max(MAX_FORWARDS);

/** What has to hold between the parts of a plan. */
function checkPlan(
    plan: {
        wans: RouterWan[];
        lans: z.infer<typeof storedLanSchema>[];
        forwards: RouterForward[];
    },
    issue: z.RefinementCtx
): void {
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
}

/** Everything the operator decides about one router. */
export const routerPlanSchema = z
    .object({
        wans: wansSchema,
        lans: z.array(lanSchema).min(1, "noNetwork").max(MAX_LANS),
        forwards: forwardsSchema
    })
    .superRefine(checkPlan);
export type RouterPlan = z.infer<typeof routerPlanSchema>;

const storedPlanSchema = z
    .object({
        wans: wansSchema,
        lans: z.array(storedLanSchema).min(1, "noNetwork").max(MAX_LANS),
        forwards: forwardsSchema
    })
    .superRefine(checkPlan);

/** A stored plan, or null: a row older than this code must not break the screen. */
export function readPlan(stored: unknown): RouterPlan | null {
    const parsed = storedPlanSchema.safeParse(stored);
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
 *  on the machine is left to the rules their engine writes, except that a network
 *  cut off from the others is cut off from them and the tailnet too. */
export function renderFirewall(plan: RouterPlan, access: RouterAccess): string {
    const wans = plan.wans.map(deviceOf);
    const lans = plan.lans.map(deviceOf);
    const open = plan.lans.filter((lan) => !lan.isolated).map(deviceOf);
    const online = plan.lans.filter((lan) => lan.internet).map(deviceOf);
    const closed = plan.lans.filter((lan) => lan.isolated).map(deviceOf);
    const confined = plan.lans.filter((lan) => lan.isolated || !lan.internet).map(deviceOf);
    const engineLinks = '{ "docker0", "br-*", "tailscale0" }';
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
        `        iifname ${quotedList([...closed, ...wans])} tcp dport ${access.sshPort} drop`,
        `        ip saddr { ${managed.join(", ")} } tcp dport ${access.sshPort} accept`,
        `        iifname ${engineLinks} accept`,
        "    }",
        "    chain forward {",
        "        type filter hook forward priority filter; policy drop;",
        "        ct state established,related accept",
        "        ct state invalid drop",
        ...(confined.length > 0
            ? [`        iifname ${quotedList(confined)} oifname ${engineLinks} drop`]
            : []),
        "        ct status dnat accept",
        `        iifname ${engineLinks} accept`,
        `        oifname ${engineLinks} accept`,
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
        // A port can be absent at boot, and this mode starts without it.
        "bind-dynamic",
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

/** Keep NetworkManager off a device Polaris configures itself. */
function unmanaged(device: string): string {
    return `! command -v nmcli >/dev/null 2>&1 || nmcli device set ${device} managed no >/dev/null 2>&1 || true`;
}

/** Docker leaves iptables' FORWARD chain on a DROP policy, and a packet has to pass
 *  every firewall on the machine, so what the router's own table accepts dies there.
 *  Only the pairs the router joins are let through, in both directions; the router's
 *  table still decides which of them pass. */
function renderDockerAllow(plan: RouterPlan): string[] {
    const lans = shellWords(plan.lans.map(deviceOf));
    const wans = shellWords(plan.wans.map(deviceOf));
    const allow = (from: string, to: string) =>
        `    for from in ${from}; do for to in ${to}; do [ "$from" = "$to" ] || iptables -w -A ${DOCKER_ALLOW_CHAIN} -i "$from" -o "$to" -j ACCEPT; done; done`;
    return [
        "if iptables -w -n -L DOCKER-USER >/dev/null 2>&1; then",
        `    iptables -w -N ${DOCKER_ALLOW_CHAIN} 2>/dev/null || iptables -w -F ${DOCKER_ALLOW_CHAIN}`,
        `    iptables -w -C DOCKER-USER -j ${DOCKER_ALLOW_CHAIN} 2>/dev/null || iptables -w -I DOCKER-USER -j ${DOCKER_ALLOW_CHAIN}`,
        allow(lans, `${lans} ${wans}`),
        allow(wans, lans),
        "fi"
    ];
}

/** Polaris's own, apart from the name the system's DHCP setup gives its client. */
function clientPid(device: string): string {
    return `/run/polaris-router/dhclient.${device}.pid`;
}

function present(port: string): string {
    return `ip link show ${port} >/dev/null 2>&1`;
}

/** Make a link's VLAN device when it has one, inside a check that its port exists. */
function tagged(link: { interface: string; vlan: number | null }): string[] {
    if (link.vlan === null) return [];
    const device = deviceOf(link);
    return [
        `    ip link set ${link.interface} up`,
        `    if ! ${present(device)}; then`,
        `        ip link add link ${link.interface} name ${device} type vlan id ${link.vlan}`,
        `        ${unmanaged(device)}`,
        "    fi"
    ];
}

function lanAddress(lan: RouterLan): string {
    return `${lan.address}/${lan.cidr.split("/")[1]}`;
}

/** Bring the networks up. Run again on every boot and every change, so each step
 *  has to hold when it is already done. */
export function renderUp(plan: RouterPlan): string {
    const lines = [
        "#!/bin/sh",
        "set -eu",
        `ip rule del priority ${ROUTE_TABLE} 2>/dev/null || true`,
        `ip rule del priority ${ROUTE_TABLE + 1} 2>/dev/null || true`,
        `ip rule add priority ${ROUTE_TABLE} lookup main suppress_prefixlength 0`,
        `ip rule add priority ${ROUTE_TABLE + 1} lookup ${ROUTE_TABLE}`
    ];
    for (const lan of plan.lans) {
        const device = deviceOf(lan);
        lines.push(`if ${present(lan.interface)}; then`, ...tagged(lan));
        lines.push(
            `    ${unmanaged(device)}`,
            `    ip link set ${device} up`,
            `    ip addr flush dev ${device}`,
            `    ip addr add ${lanAddress(lan)} dev ${device}`,
            "fi"
        );
    }
    lines.push(
        `/bin/sh ${ROUTER_DIR}/lines.sh`,
        `nft -f ${ROUTER_DIR}/rules.nft`,
        ...renderDockerAllow(plan),
        // Last: a machine that forwards has its firewall in place first.
        "sysctl -q -w net.ipv4.ip_forward=1",
        ""
    );
    return lines.join("\n");
}

/**
 * Bring up whichever lines are plugged in, and ask for an address on any that has
 * none: nothing else on the machine does that for a second port. Run on every round
 * of the watch too, so a USB line or network plugged in late joins without touching
 * the rest.
 */
export function renderLines(plan: RouterPlan): string {
    const lines = ["#!/bin/sh"];
    for (const lan of plan.lans) {
        const device = deviceOf(lan);
        lines.push(
            `if ${present(lan.interface)}; then`,
            ...tagged(lan),
            `    if [ -z "$(ip -4 -o addr show dev ${device})" ]; then`,
            `        ${unmanaged(device)}`,
            `        ip link set ${device} up`,
            `        ip addr add ${lanAddress(lan)} dev ${device}`,
            "    fi",
            "fi"
        );
    }
    for (const wan of plan.wans) {
        const device = deviceOf(wan);
        const pid = clientPid(device);
        lines.push(
            `if ${present(wan.interface)}; then`,
            ...tagged(wan),
            `    ip link set ${device} up`,
            `    sysctl -q -w net.ipv4.conf.${device.replace(".", "/")}.rp_filter=2`,
            `    if { [ -z "$(ip -4 -o addr show dev ${device})" ] || [ -f ${pid} ]; } && ! kill -0 "$(cat ${pid} 2>/dev/null)" 2>/dev/null && command -v dhclient >/dev/null 2>&1; then`,
            "        mkdir -p /var/lib/dhcp /run/polaris-router",
            `        dhclient -4 -nw -e IF_METRIC=${LINE_METRIC} -pf ${pid} -lf /var/lib/dhcp/dhclient.${device}.leases ${device}`,
            "    fi",
            "fi"
        );
    }
    lines.push("exit 0", "");
    return lines.join("\n");
}

/** Undo `renderUp`, leaving the machine as an ordinary one. */
export function renderDown(plan: RouterPlan): string {
    const lines = [
        "#!/bin/sh",
        "nft delete table inet polaris_router 2>/dev/null",
        `ip rule del priority ${ROUTE_TABLE} 2>/dev/null`,
        `ip rule del priority ${ROUTE_TABLE + 1} 2>/dev/null`,
        `ip route flush table ${ROUTE_TABLE} 2>/dev/null`,
        `iptables -w -D DOCKER-USER -j ${DOCKER_ALLOW_CHAIN} 2>/dev/null`,
        `iptables -w -F ${DOCKER_ALLOW_CHAIN} 2>/dev/null`,
        `iptables -w -X ${DOCKER_ALLOW_CHAIN} 2>/dev/null`,
        "rm -f /run/polaris-router/wan"
    ];
    for (const wan of plan.wans) {
        const pid = clientPid(deviceOf(wan));
        // The address stays, and so does this file: an address can be the system's own,
        // and taking it could cut the login. The next start renews through the file.
        lines.push(`[ ! -f ${pid} ] || kill "$(cat ${pid})" 2>/dev/null`);
    }
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
    ip -4 route show default dev "$1" 2>/dev/null | awk '/via/ { print $3; exit }'
}
current=""
bad=0
good=0
while :; do
    /bin/sh ${ROUTER_DIR}/lines.sh >/dev/null 2>&1
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
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process
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
KillMode=process
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`
};

const SERVICES = Object.keys(UNITS);
const SERVICE_LIST = SERVICES.join(" ");

/** The timer that undoes a change dies with the machine, so a restart inside its window
 *  would start the unconfirmed change for good. This finishes the timer's job at boot. */
const UNDO_UNIT = "polaris-router-undo.service";
const UNDO_UNIT_FILE = `[Unit]
Description=Polaris router undo after an interrupted change
ConditionPathExists=${UNCONFIRMED}
After=${SERVICE_LIST}

[Service]
ExecStart=/bin/sh ${ROUTER_STATE_DIR}/rollback.sh

[Install]
WantedBy=multi-user.target
`;

/** Answers true while anything is taking a change back. */
const GOING_BACK = `systemctl is-active --quiet polaris-router-rollback.service polaris-router-rollback-now.service ${UNDO_UNIT}`;

/** The packages a router needs, installed before the network is touched. */
function renderInstall(plan: RouterPlan): string {
    // Without it a VLAN line can never come up; a plain line usually has its address
    // from the machine already, so failing to get it stops nothing.
    const dhcpClient = plan.wans.some((wan) => wan.vlan !== null)
        ? `command -v dhclient >/dev/null 2>&1 || need="$need isc-dhcp-client"\n`
        : "";
    const optional = dhcpClient
        ? ""
        : `\ncommand -v dhclient >/dev/null 2>&1 || { DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq isc-dhcp-client; } >/dev/null 2>&1 || true`;
    return `need=""
${dhcpClient}command -v nft >/dev/null 2>&1 || need="$need nftables"
[ -x /usr/sbin/dnsmasq ] || need="$need dnsmasq-base"
command -v ping >/dev/null 2>&1 || need="$need iputils-ping"
command -v conntrack >/dev/null 2>&1 || need="$need conntrack"
if [ -n "$need" ]; then
    command -v apt-get >/dev/null 2>&1 || { echo unsupported-system; exit 3; }
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need >/dev/null
fi${optional}`;
}

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
 *
 * `applyId` names this change, so a confirmation cannot be answered by what ran
 * before it. Only a confirmed configuration ever becomes the way back: a change
 * replacing one nobody confirmed leaves the last good one where it is.
 */
export function renderApply(plan: RouterPlan, access: RouterAccess, applyId: string): string {
    const next = `${ROUTER_DIR}.next`;
    const previous = `${ROUTER_DIR}.previous`;
    const files: Record<string, string> = {
        "rules.nft": renderFirewall(plan, access),
        "dnsmasq.conf": renderDnsmasq(plan),
        "up.sh": renderUp(plan),
        "down.sh": renderDown(plan),
        "lines.sh": renderLines(plan),
        "wan-watch.sh": renderWanWatch(plan)
    };
    const activate = `#!/bin/sh
${STOP_ALL}
if [ -f ${UNCONFIRMED} ]; then
    rm -rf ${ROUTER_DIR}
else
    rm -rf ${previous}
    [ ! -d ${ROUTER_DIR} ] || mv ${ROUTER_DIR} ${previous}
fi
: > ${UNCONFIRMED}
mv ${next} ${ROUTER_DIR}
${START_ALL}
echo ${applyId} > ${APPLIED}
`;
    const rollback = `#!/bin/sh
systemctl stop polaris-router-activate.timer polaris-router-activate.service 2>/dev/null
${STOP_ALL}
if [ -f ${UNCONFIRMED} ]; then
    rm -rf ${ROUTER_DIR}
    [ ! -d ${previous} ] || mv ${previous} ${ROUTER_DIR}
    rm -f ${UNCONFIRMED}
fi
${START_ALL}
echo rolled-back > ${LAST}
`;
    return [
        "#!/bin/sh",
        "set -eu",
        renderInstall(plan),
        `mkdir -p ${ROUTER_STATE_DIR}`,
        `rm -rf ${next}`,
        `mkdir -p ${next}`,
        ...Object.entries(files).map(([name, content]) => heredoc(`${next}/${name}`, content)),
        ...Object.entries(UNITS).map(([name, content]) =>
            heredoc(`/etc/systemd/system/${name}`, content)
        ),
        heredoc(`/etc/systemd/system/${UNDO_UNIT}`, UNDO_UNIT_FILE),
        heredoc(`${ROUTER_STATE_DIR}/activate.sh`, activate),
        heredoc(`${ROUTER_STATE_DIR}/rollback.sh`, rollback),
        `nft -c -f ${next}/rules.nft`,
        `/usr/sbin/dnsmasq --test --conf-file=${next}/dnsmasq.conf >/dev/null 2>&1`,
        `rm -f ${LAST} ${APPLIED}`,
        "systemctl daemon-reload",
        `systemctl enable ${UNDO_UNIT} >/dev/null 2>&1`,
        "systemctl stop polaris-router-rollback.timer polaris-router-rollback.service polaris-router-rollback-now.service polaris-router-activate.timer polaris-router-activate.service 2>/dev/null || true",
        "systemctl reset-failed polaris-router-rollback.service polaris-router-rollback-now.service polaris-router-activate.service 2>/dev/null || true",
        `systemd-run --quiet --unit=polaris-router-rollback --timer-property=AccuracySec=1s --on-active=${ROLLBACK_SECONDS} /bin/sh ${ROUTER_STATE_DIR}/rollback.sh`,
        `systemd-run --quiet --unit=polaris-router-activate --timer-property=AccuracySec=1s --on-active=2 /bin/sh ${ROUTER_STATE_DIR}/activate.sh`,
        "echo accepted",
        ""
    ].join("\n");
}

/** Go back now rather than when the timer runs out. In a unit of its own, since going
 *  back can cut the connection asking for it; whoever asked reads `rolled-back` next. */
const ROLL_BACK_NOW = `systemctl stop polaris-router-rollback.timer 2>/dev/null
${GOING_BACK} || systemd-run --quiet --unit=polaris-router-rollback-now /bin/sh ${ROUTER_STATE_DIR}/rollback.sh 2>/dev/null
echo waiting`;

/** Keep the change: whoever runs this came back through the new network. Answers
 *  `confirmed` only when this very change is up, and one that failed to start is
 *  undone now rather than when the timer runs out. */
export function renderConfirm(applyId: string): string {
    return `#!/bin/sh
[ ! -f ${LAST} ] || { cat ${LAST}; exit 0; }
[ "$(cat ${APPLIED} 2>/dev/null)" = "${applyId}" ] || { echo waiting; exit 0; }
if systemctl is-failed --quiet polaris-router.service; then
    ${ROLL_BACK_NOW}
    exit 0
fi
systemctl is-active --quiet polaris-router.service || { echo waiting; exit 0; }
systemctl is-active --quiet polaris-router-dns.service || { echo waiting; exit 0; }
systemctl stop polaris-router-rollback.timer 2>/dev/null
! ${GOING_BACK} || { echo waiting; exit 0; }
[ ! -f ${LAST} ] || { cat ${LAST}; exit 0; }
rm -f ${UNCONFIRMED}
echo confirmed
`;
}

/** Give up on a change that never confirmed, unless it did and the answer was lost.
 *  Asked again until it says how it ended. */
export function renderRollback(applyId: string): string {
    return `#!/bin/sh
[ ! -f ${LAST} ] || { cat ${LAST}; exit 0; }
if [ "$(cat ${APPLIED} 2>/dev/null)" = "${applyId}" ] && [ ! -f ${UNCONFIRMED} ]; then
    echo confirmed
    exit 0
fi
${ROLL_BACK_NOW}
`;
}

/** Make the machine an ordinary one again. */
export const REMOVE_SCRIPT = `#!/bin/sh
systemctl stop polaris-router-rollback.timer polaris-router-activate.timer 2>/dev/null
${STOP_ALL}
systemctl disable ${SERVICE_LIST} ${UNDO_UNIT} >/dev/null 2>&1
rm -rf ${ROUTER_DIR} ${ROUTER_DIR}.next ${ROUTER_DIR}.previous
rm -f ${UNCONFIRMED} ${APPLIED} ${LAST}
rm -rf /run/polaris-router
rm -f ${[...SERVICES, UNDO_UNIT].map((name) => `/etc/systemd/system/${name}`).join(" ")}
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
head -n ${MAX_CLIENTS} ${ROUTER_STATE_DIR}/leases 2>/dev/null
echo "---counters"
ip -j -s link show 2>/dev/null || echo '[]'
echo "---last"
cat ${LAST} 2>/dev/null
echo "---end"
`;
