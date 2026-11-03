/**
 * What the Router screen works out for the operator so a field never starts blank or
 * unexplained: the next VLAN tag a port has free, which lines and networks ride each
 * port, which of them collide, and the one fix that ends a collision. Pure, so the
 * suggestions are asserted in tests; nothing here changes what reaches a machine.
 */

import { isHostOf, isUsableCidr, normalizeCidr } from "@/lib/vpn/networks";
import { deviceOf, type RouterLan, type RouterPlan, type RouterWan } from "./plan";

/** The tags offered first, the way most switches and controllers number networks. */
const ROUND_TAGS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const VLAN_MIN = 2;
const VLAN_MAX = 4094;

/** One line or network as it rides a port. */
export interface PortLink {
    readonly kind: "line" | "network";
    /** A line's place in the failover order, from 0; a network's id. */
    readonly key: string;
    readonly name: string;
    readonly port: string;
    readonly vlan: number | null;
}

/** Every line and network, by what they ride. Lines are named by their order. */
export function linksOf(plan: Pick<RouterPlan, "wans" | "lans">): PortLink[] {
    return [
        ...plan.wans.map((wan: RouterWan, at) => ({
            kind: "line" as const,
            key: String(at),
            name: String(at + 1),
            port: wan.interface,
            vlan: wan.vlan
        })),
        ...plan.lans.map((lan: RouterLan) => ({
            kind: "network" as const,
            key: lan.id,
            name: lan.name,
            port: lan.interface,
            vlan: lan.vlan
        }))
    ];
}

/** The lowest tag no link on `port` uses: a round one while one is free. */
export function nextFreeVlan(links: readonly PortLink[], port: string): number {
    const used = new Set(links.filter((link) => link.port === port).map(({ vlan }) => vlan));
    const round = ROUND_TAGS.find((tag) => !used.has(tag));
    if (round !== undefined) return round;
    for (let tag = VLAN_MIN; tag <= VLAN_MAX; tag += 1) if (!used.has(tag)) return tag;
    return VLAN_MIN;
}

/** Links that would share one device, which the machine cannot tell apart. */
export interface PortClash {
    readonly port: string;
    readonly vlan: number | null;
    readonly links: readonly PortLink[];
}

export function portClashes(plan: Pick<RouterPlan, "wans" | "lans">): PortClash[] {
    const byDevice = new Map<string, PortLink[]>();
    for (const link of linksOf(plan)) {
        const device = deviceOf({ interface: link.port, vlan: link.vlan });
        byDevice.set(device, [...(byDevice.get(device) ?? []), link]);
    }
    return [...byDevice.values()]
        .filter((links) => links.length > 1)
        .map((links) => ({ port: links[0]!.port, vlan: links[0]!.vlan, links }));
}

/** The link a clash is best ended by tagging: a network rather than a line, since a
 *  line's VLAN is the provider's to set, and never a network on the air, since Wi-Fi
 *  cannot run on a VLAN. Null when only lines collide. */
export function clashFix(
    plan: Pick<RouterPlan, "wans" | "lans">,
    clash: PortClash
): { lanId: string; vlan: number } | null {
    const movable = clash.links.filter(
        (link) => link.kind === "network" && !plan.lans.find(({ id }) => id === link.key)?.wifi
    );
    const pick = movable[movable.length - 1];
    if (!pick) return null;
    return { lanId: pick.key, vlan: nextFreeVlan(linksOf(plan), clash.port) };
}

/** The plan with one network moved onto a VLAN of its port. */
export function withLanVlan(plan: RouterPlan, lanId: string, vlan: number): RouterPlan {
    return {
        ...plan,
        lans: plan.lans.map((lan) => (lan.id === lanId ? { ...lan, vlan } : lan))
    };
}

/** How many devices a subnet holds besides the router, or null when it cannot be used. */
export function hostCount(cidr: string): number | null {
    const clean = normalizeCidr(cidr);
    if (!isUsableCidr(clean)) return null;
    const prefix = Number(clean.split("/")[1]);
    return 2 ** (32 - prefix) - 3;
}

/** The network a device's address belongs to. */
export function networkOf(lans: readonly RouterLan[], address: string): RouterLan | null {
    return lans.find((lan) => isHostOf(lan.cidr, address)) ?? null;
}

/** Whether a machine has one wired port, so a line and a network share it untagged
 *  unless the networks are VLANs: a VPS, or a Pi with no USB adapter yet. */
export function singleWiredPort(wired: readonly string[]): string | null {
    return wired.length === 1 ? (wired[0] ?? null) : null;
}

/** A VLAN tag as typed: digits only, empty meaning untagged. */
export function vlanError(vlan: number | null): "badVlan" | null {
    if (vlan === null) return null;
    return Number.isInteger(vlan) && vlan >= VLAN_MIN && vlan <= VLAN_MAX ? null : "badVlan";
}

/** Who else already rides `port` with this tag, so the field can say so as it is typed. */
export function vlanTakenBy(
    links: readonly PortLink[],
    self: { kind: PortLink["kind"]; key: string },
    port: string,
    vlan: number | null
): PortLink | null {
    return (
        links.find(
            (link) =>
                !(link.kind === self.kind && link.key === self.key) &&
                deviceOf({ interface: link.port, vlan: link.vlan }) ===
                    deviceOf({ interface: port, vlan })
        ) ?? null
    );
}
