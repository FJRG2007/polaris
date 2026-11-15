/**
 * The operator's answer for how game ports are handed out and opened.
 *
 * Kept apart from `port-block.ts` because that half is rendered in the browser -
 * the router instructions import it to write the rule - and this half reaches for
 * the database. Config lives in the `Setting` table beside the other `network.*`
 * keys, so there is no schema change.
 */

import { getSetting, setSetting } from "@/lib/setting-store";
import {
    parseBlock,
    portRangesSchema,
    portPolicySchema,
    portBlockSchema,
    DEFAULT_PORT_BLOCKS,
    type PortBlock,
    type PortBlocks,
    type PortPolicy,
    type PortRanges,
    type PortProtocol
} from "@/lib/apps/port-block";

const KEYS = {
    policy: "network.portPolicy",
    tcp: "network.portBlock.tcp",
    udp: "network.portBlock.udp"
} as const;

/** How the router is asked to open the game ports. Defaults to the range, which
 *  is the one that does not need revisiting every time a server is created. */
export async function getPortPolicy(): Promise<PortPolicy> {
    const stored = portPolicySchema.safeParse(await getSetting(KEYS.policy));
    return stored.success ? stored.data : "range";
}

export async function setPortPolicy(policy: PortPolicy): Promise<void> {
    await setSetting(KEYS.policy, portPolicySchema.parse(policy));
}

/** The block each transport allocates from. */
export async function getPortBlocks(): Promise<PortBlocks> {
    const [tcp, udp] = await Promise.all([getSetting(KEYS.tcp), getSetting(KEYS.udp)]);
    return {
        tcp: parseBlock(tcp, DEFAULT_PORT_BLOCKS.tcp),
        udp: parseBlock(udp, DEFAULT_PORT_BLOCKS.udp)
    };
}

/**
 * Store a block. Validated here as well as at the action, because this is also
 * the door a later caller comes through, and a block that swallowed 80 or 443
 * would break the websites rather than the games.
 */
export async function setPortBlock(protocol: PortProtocol, block: PortBlock): Promise<void> {
    const parsed = portBlockSchema.parse(block);
    await setSetting(protocol === "tcp" ? KEYS.tcp : KEYS.udp, JSON.stringify(parsed));
}

/** One host's own ranges live under a key of their own, so a deployment with
 *  thousands of hosts reads one row for the host it is allocating on. */
const RANGES_KEY = "network.portRanges.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rangesKey(targetId: string): string {
    if (!UUID.test(targetId)) throw new Error("Not a host id");
    return `${RANGES_KEY}${targetId.toLowerCase()}`;
}

/** The ranges a host declared for itself, or null when it uses the shared block.
 *  A stored value this version does not accept reads as unset, never as a throw. */
export async function getHostPortRanges(targetId: string): Promise<PortRanges | null> {
    const raw = await getSetting(rangesKey(targetId));
    if (!raw) return null;
    try {
        const parsed = portRangesSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Stores a host's ranges, or clears them (null) so it falls back to the shared block. */
export async function setHostPortRanges(targetId: string, ranges: PortRanges | null): Promise<void> {
    const key = rangesKey(targetId);
    await setSetting(key, ranges === null ? null : JSON.stringify(portRangesSchema.parse(ranges)));
}

/** The ranges ports are allocated from on a host: its own when it has them, else
 *  the shared block as a one-entry list. */
export async function getPortRangesFor(targetId?: string | null): Promise<PortRanges> {
    const own = targetId ? await getHostPortRanges(targetId).catch(() => null) : null;
    if (own) return own;
    const blocks = await getPortBlocks();
    return { tcp: [blocks.tcp], udp: [blocks.udp] };
}
