/**
 * What the relay server's cloud firewall has to let in, as rules to type.
 *
 * Pure, since the card that draws it runs in the browser. The steps themselves
 * live in the `admin` catalog, keyed by cloud; `steps` says how many there are.
 * Menu names come from each provider's own help pages.
 */

import { CALL_PORTS } from "@/lib/chat/call-ports";
import { FIRST_LISTEN_PORT, LAST_LISTEN_PORT } from "@/lib/deploy/wireguard/listen-ports";

export type FirewallPurpose = "link" | "web" | "calls" | "tunnels" | "games";

export interface FirewallRule {
    readonly protocol: "TCP" | "UDP";
    readonly port: number;
    readonly endPort: number;
    readonly purpose: FirewallPurpose;
}

/** Whether a rule is known to work. UDP says nothing when knocked on, so only
 *  the link's own port can be told apart, by the link coming up. */
export type FirewallRuleState = "open" | "closed" | "unknown";

/** The part of a pass's findings that speaks for the relay's firewall. */
export interface RelayFirewallProbe {
    readonly latency: { readonly relay: number | null };
    readonly problem: string | null;
    readonly relayClosed: readonly number[] | null;
    readonly relayUnclear: readonly number[];
}

export const CLOUD_FIREWALLS = [
    { id: "ionos", label: "IONOS", url: "https://my.ionos.com/account", steps: 3 },
    { id: "hetzner", label: "Hetzner", url: "https://console.hetzner.com/", steps: 3 },
    {
        id: "digitalocean",
        label: "DigitalOcean",
        url: "https://cloud.digitalocean.com/networking/firewalls",
        steps: 3
    },
    { id: "aws", label: "AWS", url: "https://console.aws.amazon.com/ec2/", steps: 3 },
    { id: "other", label: null, url: null, steps: 2 }
] as const;

export type CloudFirewall = (typeof CLOUD_FIREWALLS)[number]["id"];

/** The cloud a server is named after, which is how most people name them. */
export function detectCloud(serverName: string | null): CloudFirewall {
    const name = serverName?.toLowerCase() ?? "";
    return CLOUD_FIREWALLS.find((cloud) => name.includes(cloud.id))?.id ?? "other";
}

function purposeOf(protocol: "tcp" | "udp", port: number): FirewallPurpose {
    if (protocol === "tcp" && (port === 80 || port === 443)) return "web";
    if (CALL_PORTS.some((call) => call.protocol === protocol && call.port === port)) return "calls";
    if (protocol === "udp" && port >= FIRST_LISTEN_PORT && port <= LAST_LISTEN_PORT)
        return "tunnels";
    return "games";
}

/** Every rule the relay needs, the link first since nothing works without it.
 *  Neighbouring ports with the same purpose become one range. */
export function relayFirewallRules(
    listenPort: number,
    tcp: readonly number[],
    udp: readonly number[]
): FirewallRule[] {
    const rules: FirewallRule[] = [
        { protocol: "UDP", port: listenPort, endPort: listenPort, purpose: "link" }
    ];
    for (const protocol of ["tcp", "udp"] as const) {
        let open: FirewallRule | null = null;
        for (const port of [...(protocol === "tcp" ? tcp : udp)].sort((a, b) => a - b)) {
            const purpose = purposeOf(protocol, port);
            if (open && open.endPort + 1 === port && open.purpose === purpose) {
                open = { protocol: open.protocol, port: open.port, endPort: port, purpose };
                rules[rules.length - 1] = open;
                continue;
            }
            open = { protocol: protocol === "tcp" ? "TCP" : "UDP", port, endPort: port, purpose };
            rules.push(open);
        }
    }
    return rules;
}

/** The link's rule, shut only when the relay's own 443 answers and visitors
 *  still do not get through: anything else says nothing about its UDP port. */
export function linkState(probe: RelayFirewallProbe | null): FirewallRuleState {
    if (probe?.latency.relay != null) return "open";
    if (probe?.problem !== "relay-unreachable" || probe.relayClosed === null) return "unknown";
    const answered = !probe.relayClosed.includes(443) && !probe.relayUnclear.includes(443);
    return answered ? "closed" : "unknown";
}

function inRule(rule: FirewallRule, port: number): boolean {
    return port >= rule.port && port <= rule.endPort;
}

/** `closed` is what the last pass found shut, or null before one has looked, and
 *  `unclear` what failed in a way that does not point at the firewall. */
export function ruleState(
    rule: FirewallRule,
    link: FirewallRuleState,
    closed: readonly number[] | null,
    unclear: readonly number[]
): FirewallRuleState {
    if (rule.purpose === "link") return link;
    if (rule.protocol === "UDP" || closed === null) return "unknown";
    if (closed.some((port) => inRule(rule, port))) return "closed";
    return unclear.some((port) => inRule(rule, port)) ? "unknown" : "open";
}

/** How many ports a rule in `state` still has shut, since a range is several. */
export function blockedPorts(
    rule: FirewallRule,
    state: FirewallRuleState,
    closed: readonly number[]
): number {
    if (state !== "closed") return 0;
    return rule.purpose === "link" ? 1 : closed.filter((port) => inRule(rule, port)).length;
}
