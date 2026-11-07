/**
 * Whether devices' packets reach a VPN node's WireGuard port, as the screens
 * show it, and where the rule that opens it goes. Pure, since both the admin's
 * list and the connect screen draw it in the browser.
 */

import { isPublicEndpoint } from "@/lib/vpn/wireguard";
import { detectCloud } from "@/lib/backup-access/firewall-guide";

/** What a check found: `unknown` when it could not tell (the machine did not
 *  answer Polaris), `unchecked` before anything was asked or when the answer is
 *  too old to stand for now. */
export type NodeReach = "reachable" | "blocked" | "unknown" | "unchecked";

/** The schedule checks every five minutes; an answer that missed several passes
 *  says nothing about the port today. */
export const REACH_STALE_MS = 30 * 60_000;

export function nodeReach(
    verdict: string | null | undefined,
    checkedAt: Date | string | null | undefined,
    now: Date
): NodeReach {
    if (verdict === "unknown") return "unknown";
    if (verdict !== "open" && verdict !== "blocked") return "unchecked";
    if (!checkedAt) return "unchecked";
    if (now.getTime() - new Date(checkedAt).getTime() > REACH_STALE_MS) return "unchecked";
    return verdict === "open" ? "reachable" : "blocked";
}

/** Where the rule goes: the hosting provider's firewall, or a forward on the
 *  operator's own router. */
export type FirewallPlace = "cloud" | "router";

/**
 * A machine Polaris reaches at a private address sits behind a router, whose
 * public address is what devices dial, so the port is forwarded there. Reached
 * at a public address, nothing of the operator's stands in front of it and the
 * provider's firewall is what drops it. A server named after its provider is a
 * provider's, whatever address Polaris uses. Only a starting point: the screen
 * keeps it a choice, as the router's brand is.
 */
export function firewallPlace(hostName: string, hostAddress: string): FirewallPlace {
    if (detectCloud(hostName) !== "other") return "cloud";
    return isPublicEndpoint(hostAddress) ? "cloud" : "router";
}

/**
 * Whether a `blocked` from here can be taken at its word. The knock leaves this
 * server for the node's public address; a node behind a router is knocked on
 * through that router, and one that does not loop its own address back inward
 * drops the knock while devices outside get through. Only a machine with a
 * public address of its own is told so to the people connecting.
 */
export function blockedIsCertain(hostAddress: string): boolean {
    return isPublicEndpoint(hostAddress);
}

/** The one rule a node needs: WireGuard is UDP, from any address, to the node. */
export interface NodeFirewallRule {
    readonly protocol: "UDP";
    readonly port: number;
    readonly destination: string;
}

export function nodeFirewallRule(endpoint: string, port: number): NodeFirewallRule {
    return { protocol: "UDP", port, destination: endpoint };
}
