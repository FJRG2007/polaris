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
    portPolicySchema,
    portBlockSchema,
    DEFAULT_PORT_BLOCKS,
    type PortBlock,
    type PortBlocks,
    type PortPolicy,
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
