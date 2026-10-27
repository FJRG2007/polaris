/**
 * Whether visitors can reach this line at all, and what follows from it.
 *
 * Pure. A line behind carrier-grade NAT (Starlink's residential plans, most
 * mobile uplinks, a growing number of fibre ISPs) goes out fine and takes
 * nothing in: the address the echo services report belongs to the carrier and is
 * shared with hundreds of other customers. Publishing it in DNS sends every
 * visitor to somebody else's router, and a call server that hands it out sends
 * every caller's sound nowhere.
 *
 * The evidence is gathered by `inbound-service.ts`; this decides from it, so the
 * DNS follower, backup access, the call server and every screen ask one question
 * and get one answer.
 */

import { z } from "zod";
import type { BackupPath } from "./decision";
import { isCarrierGradeNat, isIpv4, isPublicIpv4, type ServerEnvironment } from "@polaris/core";

/** Where the last verdict is kept (`inbound-service.ts` writes it). */
export const INBOUND_KEY = "network.inboundReach";

/** Reverse names Starlink gives its customer addresses (`customer.<pop>.pop.starlinkisp.net`). */
const STARLINK_PTR = /(^|\.)starlinkisp\.net\.?$/i;

export const CGNAT_REASONS = [
    "carrier-address",
    "router-wan",
    "starlink",
    "no-inbound",
    "address-mismatch"
] as const;
export type CgnatReason = (typeof CGNAT_REASONS)[number];

export interface InboundEvidence {
    /** The box's own address, as configured or found on its interface. */
    readonly ownIp: string | null;
    /** The router's WAN address, when the router reports one. */
    readonly routerWanIp: string | null;
    /** What the internet sees: the address the echo services answered. */
    readonly publicIp: string | null;
    /** Reverse names of `publicIp`. */
    readonly ptr: readonly string[];
    /** A check from a machine outside the house, aimed at `publicIp`. */
    readonly outside: "up" | "down" | null;
    /** This box reached its own public address and back (a hairpin), at `publicIp`. */
    readonly hairpin: boolean;
    /** The address a STUN server mapped this box to, when one was asked. */
    readonly stunIp: string | null;
}

export const inboundReachSchema = z.object({
    checkedAt: z.string(),
    publicIp: z.string().nullable(),
    cgnat: z.boolean(),
    /** True when the evidence is conclusive (a carrier address seen directly). */
    certain: z.boolean(),
    reason: z.enum(CGNAT_REASONS).nullable(),
    /** Visitors were seen to get in at `publicIp`. */
    inboundProven: z.boolean(),
    /** A global IPv6 address of this box, and whether it took a connection from outside. */
    ipv6: z.string().nullable().default(null),
    ipv6Inbound: z.boolean().nullable().default(null),
    /** The uplink changed (a new public address) since the last check. */
    uplinkChangedAt: z.string().nullable().default(null)
});
export type InboundReach = z.infer<typeof inboundReachSchema>;

export interface CgnatVerdict {
    readonly cgnat: boolean;
    readonly certain: boolean;
    readonly reason: CgnatReason | null;
    readonly inboundProven: boolean;
}

/**
 * Decide from the evidence. A carrier address seen directly - on the box or on
 * the router's WAN - is conclusive and nothing outweighs it. Otherwise a
 * connection from outside that was seen to get in proves the line takes
 * visitors, whatever its reverse name says (Starlink sells public addresses too).
 * A hairpin is weaker - the router's own page, or somebody else's router behind
 * a carrier address, answers it too - so it counts only when no outside check
 * answered and the reverse name is not Starlink's. Without proof, a Starlink
 * reverse name, or an outside check that could not get in while this box gets
 * out, is enough to stop treating the address as a way in.
 */
export function detectCgnat(evidence: InboundEvidence): CgnatVerdict {
    const starlink = evidence.ptr.some((name) => STARLINK_PTR.test(name));
    const inboundProven =
        evidence.outside === "up" || (evidence.outside === null && evidence.hairpin && !starlink);
    const found = (reason: CgnatReason, certain: boolean): CgnatVerdict => ({
        cgnat: true,
        certain,
        reason,
        inboundProven: certain ? false : inboundProven
    });
    if (evidence.ownIp && isIpv4(evidence.ownIp) && isCarrierGradeNat(evidence.ownIp))
        return found("carrier-address", true);
    if (evidence.routerWanIp && isIpv4(evidence.routerWanIp)) {
        if (isCarrierGradeNat(evidence.routerWanIp)) return found("router-wan", true);
        // The router's own WAN address is not the one the internet sees: a
        // second NAT sits between them.
        if (
            isPublicIpv4(evidence.routerWanIp) &&
            evidence.publicIp &&
            evidence.publicIp !== evidence.routerWanIp
        )
            return found("router-wan", true);
    }
    if (inboundProven) return { cgnat: false, certain: false, reason: null, inboundProven };
    if (starlink) return found("starlink", false);
    if (evidence.outside === "down") return found("no-inbound", false);
    if (evidence.stunIp && evidence.publicIp && evidence.stunIp !== evidence.publicIp)
        return found("address-mismatch", false);
    return { cgnat: false, certain: false, reason: null, inboundProven };
}

/**
 * Whether the verdict says what kind of line this is, rather than only that
 * nothing got in. A failed outside check alone is also what a home router with
 * no forward yet looks like, and calling that line a carrier NAT would tell its
 * operator that no forward can help - the one fix it needs.
 */
export function lineIsCgnat(
    reach: Pick<InboundReach, "cgnat" | "certain" | "reason"> | null
): boolean {
    return Boolean(reach?.cgnat && (reach.certain || reach.reason === "starlink"));
}

/**
 * The environment safety decisions act on. The operator's answer is shown and
 * used for guidance, but a carrier-NAT line detected now wins over an answer
 * given back when the line was another one: DNS must not be pointed at it.
 */
export function actingEnvironment(
    answered: ServerEnvironment | null,
    detected: ServerEnvironment,
    reach: Pick<InboundReach, "cgnat" | "certain" | "reason"> | null
): ServerEnvironment {
    if (detected === "home-cgnat" || lineIsCgnat(reach)) {
        // A datacenter box is never behind a carrier NAT of a home line.
        if (answered === "cloud" || answered === "vps") return answered;
        return "home-cgnat";
    }
    return answered ?? detected;
}

export type PublishRefusal = "backup" | "cgnat" | "not-public";

/**
 * Whether the DNS follower may point the records at `ip`. Backup access owns the
 * records while it serves; an address that is not public, or that is known not
 * to take visitors, is never published.
 */
export function mayPublish(input: {
    readonly ip: string;
    readonly reach: Pick<InboundReach, "cgnat" | "publicIp"> | null;
    readonly backupServing: boolean;
}): { readonly publish: boolean; readonly refusal: PublishRefusal | null } {
    if (input.backupServing) return { publish: false, refusal: "backup" };
    if (!isPublicIpv4(input.ip) || isCarrierGradeNat(input.ip))
        return { publish: false, refusal: "not-public" };
    // A verdict about another address says nothing about this one.
    if (input.reach?.cgnat && input.reach.publicIp === input.ip)
        return { publish: false, refusal: "cgnat" };
    return { publish: true, refusal: null };
}

/**
 * Whether backup access should treat the line as down regardless of the probes,
 * and how many checks it needs: a carrier NAT detected for certain needs no
 * second opinion, a suspected one gets the usual streak.
 */
export function cgnatVerdict(
    reach: Pick<InboundReach, "cgnat" | "certain" | "publicIp"> | null,
    currentIp: string | null
): { readonly down: boolean; readonly failToFlip: number | undefined } {
    if (!reach?.cgnat || !currentIp || reach.publicIp !== currentIp)
        return { down: false, failToFlip: undefined };
    return { down: true, failToFlip: reach.certain ? 1 : undefined };
}

/**
 * The address the call server must hand to callers. While the relay serves, the
 * media arrives at the relay's public address and is carried home through the
 * link, so that is the one to advertise: the STUN answer would be the carrier's
 * shared address, which takes nothing in. Null means "ask STUN", the direct path.
 */
export function callNodeIp(input: {
    readonly serving: "direct" | "backup";
    readonly path: BackupPath | null;
    readonly relayAddress: string | null;
}): string | null {
    if (input.serving !== "backup" || input.path !== "relay" || !input.relayAddress) return null;
    return isPublicIpv4(input.relayAddress) ? input.relayAddress : null;
}

export type CallReach = "direct" | "relay" | "local-only";

/** How a caller outside the house reaches the call server's media. */
export function callReach(input: {
    readonly cgnat: boolean;
    readonly serving: "direct" | "backup";
    readonly path: BackupPath | null;
    readonly relayAddress: string | null;
}): CallReach {
    if (callNodeIp(input)) return "relay";
    // A tunnel carries the web only: signalling on 443 gets through, media does not.
    if (input.cgnat || input.serving === "backup") return "local-only";
    return "direct";
}

export type CallsOutside = "cgnat" | "backup";

/**
 * Why a caller outside the house cannot reach the call media, or null when they
 * can. "cgnat": the line takes nothing in and no relay carries the media.
 * "backup": a tunnel serves the web while the direct line is down, and a tunnel
 * carries no media. People in the house can still call either way.
 */
export function callsOutside(input: Parameters<typeof callReach>[0]): CallsOutside | null {
    if (callReach(input) !== "local-only") return null;
    return input.cgnat ? "cgnat" : "backup";
}

/** The ways in Polaris can offer, the direct line included. */
export const INBOUND_PATHS = ["direct", "relay", "tunnel", "tailscale", "ipv6"] as const;
export type InboundPath = (typeof INBOUND_PATHS)[number];

export const INBOUND_FEATURES = ["web", "ownDomain", "calls", "games", "mail", "everyone"] as const;
export type InboundFeature = (typeof INBOUND_FEATURES)[number];

/**
 * What each path carries. `everyone`: any visitor, not only IPv6-capable ones or
 * members of a private network.
 */
export const PATH_FEATURES: Readonly<Record<InboundPath, readonly InboundFeature[]>> = {
    direct: ["web", "ownDomain", "calls", "games", "mail", "everyone"],
    relay: ["web", "ownDomain", "calls", "games", "mail", "everyone"],
    tunnel: ["web", "ownDomain", "everyone"],
    tailscale: ["web"],
    ipv6: ["web", "ownDomain", "calls", "games", "mail"]
};

export function carries(path: InboundPath, feature: InboundFeature): boolean {
    return PATH_FEATURES[path].includes(feature);
}

/**
 * The path to recommend. A relay on a server the operator owns carries
 * everything to everyone and grows with the server; a Cloudflare tunnel carries
 * the web at no cost; Tailscale reaches the operator's own devices. The direct
 * line wins whenever it takes visitors.
 */
export function recommendPath(input: {
    readonly cgnat: boolean;
    readonly hasServer: boolean;
    readonly cloudflare: boolean;
    readonly tailscale: boolean;
}): InboundPath {
    if (!input.cgnat) return "direct";
    if (input.hasServer) return "relay";
    if (input.cloudflare) return "tunnel";
    if (input.tailscale) return "tailscale";
    return "relay";
}

/** A global unicast IPv6 address (2000::/3), the only kind worth publishing. */
export function isGlobalIpv6(value: string): boolean {
    if (!value.includes(":")) return false;
    const first = Number.parseInt(value.split(":")[0] || "0", 16);
    return Number.isFinite(first) && first >= 0x2000 && first <= 0x3fff;
}

/**
 * The AAAA record to publish, or null. Only an address this box holds that took
 * a connection from outside: Starlink hands out a public prefix, but its router
 * firewall may drop inbound. The A record is left to the relay or the tunnel.
 */
export function planAaaa(input: {
    readonly ipv6: string | null;
    readonly ipv6Inbound: boolean | null;
}): string | null {
    if (!input.ipv6 || !isGlobalIpv6(input.ipv6)) return null;
    return input.ipv6Inbound === true ? input.ipv6 : null;
}

/** Read a stored reach, null for anything unreadable. */
export function readReach(raw: string | null): InboundReach | null {
    if (!raw) return null;
    try {
        const parsed = inboundReachSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
