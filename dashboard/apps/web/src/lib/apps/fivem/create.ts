/**
 * Picking the port a FiveM server will answer on.
 *
 * Apart from this the whole of what a server is made of is pure and lives in
 * `config.ts`, which is what the create dialog renders from. This half is the one
 * that has to look at what every other server on this Polaris already took.
 *
 * One number and two doors. A FiveM client speaks TCP and UDP to the same port,
 * and a player is given one number - so the port has to be free on both
 * transports, which is not a question `availableHostPort` asks: it allocates
 * inside one transport's block, and the two blocks do not overlap. So the number
 * is taken from the TCP block, where the connection actually begins, and checked
 * against the UDP claims as well. Its UDP half then sits outside the UDP block,
 * which the Domains screen already notices and says out loud - it lists every
 * server whose ports fall outside a range rule.
 */

import { getPortBlocks } from "@/lib/apps/port-block-store";
import { PREFERRED_HOST_PORT } from "@/lib/apps/fivem/config";
import { describeBlock, inBlock } from "@/lib/apps/port-block";
import { portKey, takenHostPorts } from "@/lib/apps/port-registry";

/** A free port, on both transports at once. */
export async function allocateFivemPort(): Promise<number> {
    const [taken, blocks] = await Promise.all([takenHostPorts(), getPortBlocks()]);
    const block = blocks.tcp;
    const free = (port: number): boolean =>
        inBlock(port, block) && !taken.has(portKey(port, "tcp")) && !taken.has(portKey(port, "udp"));
    if (free(PREFERRED_HOST_PORT)) return PREFERRED_HOST_PORT;
    // From the preferred port onward before wrapping, so a second server lands
    // beside the first rather than at the bottom of the block.
    const from = inBlock(PREFERRED_HOST_PORT, block) ? PREFERRED_HOST_PORT : block.start;
    for (let port = from; port <= block.end; port += 1) if (free(port)) return port;
    for (let port = block.start; port < from; port += 1) if (free(port)) return port;
    throw new Error(
        `Every port in the range ${describeBlock(block)} is in use. Widen it under Admin, Domains, or remove a server that is no longer running.`
    );
}
