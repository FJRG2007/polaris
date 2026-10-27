/**
 * Gathers the evidence `inbound.ts` decides from and keeps the answer in
 * settings, so the DNS follower, the environment detection, the call server and
 * the screens read one stored verdict instead of each probing on its own.
 *
 * Refreshed on every backup-access pass (each minute), which already measured
 * the public address and asked the outside machine; this adds only a reverse
 * lookup, and only when the address is new.
 */

import { reverse } from "node:dns/promises";
import { getPublicIp } from "@/lib/domain-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { detectLocalEnvironment } from "@/lib/network-service";
import { detectCgnat, INBOUND_KEY, readReach, type InboundReach } from "./inbound";

const PTR_KEY = "network.publicIpPtr";
const PTR_TIMEOUT_MS = 3_000;

export async function readInboundReach(): Promise<InboundReach | null> {
    return readReach(await getSetting(INBOUND_KEY));
}

/** Reverse names of an address, cached against it. Empty when there are none. */
async function reverseNames(ip: string): Promise<string[]> {
    try {
        const cached = JSON.parse((await getSetting(PTR_KEY)) ?? "null") as unknown;
        if (
            cached &&
            typeof cached === "object" &&
            (cached as { ip?: unknown }).ip === ip &&
            Array.isArray((cached as { names?: unknown }).names)
        )
            return (cached as { names: unknown[] }).names.filter(
                (name): name is string => typeof name === "string"
            );
    } catch {
        // Unreadable cache: look again.
    }
    const names = await Promise.race([
        reverse(ip).catch(() => [] as string[]),
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), PTR_TIMEOUT_MS))
    ]);
    await setSetting(PTR_KEY, JSON.stringify({ ip, names }));
    return names;
}

export interface ReachInput {
    /** The public address this pass measured; null when nobody answered. */
    readonly publicIp: string | null;
    readonly outside: "up" | "down" | null;
    readonly hairpin: boolean;
    readonly ipv6?: string | null;
    readonly ipv6Inbound?: boolean | null;
}

/**
 * Decide and store. Proof of inbound outlives a pass that could not check (an
 * outside machine that was briefly away), but only for the same address: a new
 * address starts from nothing, and re-runs the environment detection.
 */
export async function refreshInboundReach(input: ReachInput): Promise<InboundReach | null> {
    const previous = await readInboundReach();
    if (!input.publicIp) return previous;
    const sameIp = previous?.publicIp === input.publicIp;
    const [ownIp, ptr] = await Promise.all([
        getPublicIp().catch(() => null),
        reverseNames(input.publicIp)
    ]);
    const verdict = detectCgnat({
        ownIp,
        routerWanIp: null,
        publicIp: input.publicIp,
        ptr,
        outside: input.outside,
        hairpin: input.hairpin || (sameIp && input.outside === null && !!previous?.inboundProven),
        stunIp: null
    });
    const now = new Date().toISOString();
    const reach: InboundReach = {
        checkedAt: now,
        publicIp: input.publicIp,
        ...verdict,
        ipv6: input.ipv6 ?? previous?.ipv6 ?? null,
        ipv6Inbound: input.ipv6Inbound ?? (sameIp ? (previous?.ipv6Inbound ?? null) : null),
        uplinkChangedAt: sameIp || !previous ? (previous?.uplinkChangedAt ?? null) : now
    };
    await setSetting(INBOUND_KEY, JSON.stringify(reach));
    // The uplink moved (a failover to the other line) or the verdict flipped:
    // the stored environment was learned on the other line.
    if (!sameIp || previous?.cgnat !== reach.cgnat)
        await detectLocalEnvironment(true).catch(() => undefined);
    return reach;
}
