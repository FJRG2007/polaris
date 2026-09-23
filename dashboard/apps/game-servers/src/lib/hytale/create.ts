/**
 * Picking the port a Hytale server will answer on.
 *
 * One transport and one door: Hytale speaks QUIC, which is UDP, and a client is
 * given one number. So unlike FiveM - whose port has to be free on both
 * transports because its connection begins over TCP - this only asks the UDP
 * block, which is the block a game port belongs in anyway.
 */

import { HYTALE_PORT } from "./paths";
import { host } from "@polaris/app-host";

const { getPortBlocks } = host.appsPortBlockStore;
const { describeBlock, inBlock } = host.appsPortBlock;
const { portKey, takenHostPorts } = host.appsPortRegistry;

/** A free UDP port, preferring the one every guide tells players to expect. */
export async function allocateHytalePort(): Promise<number> {
    const [taken, blocks] = await Promise.all([takenHostPorts(), getPortBlocks()]);
    const block = blocks.udp;
    const free = (port: number): boolean => inBlock(port, block) && !taken.has(portKey(port, "udp"));
    if (free(HYTALE_PORT)) return HYTALE_PORT;
    // From the preferred port onward before wrapping, so a second server lands
    // beside the first rather than at the bottom of the block.
    const from = inBlock(HYTALE_PORT, block) ? HYTALE_PORT : block.start;
    for (let port = from; port <= block.end; port += 1) if (free(port)) return port;
    for (let port = block.start; port < from; port += 1) if (free(port)) return port;
    throw new Error(
        `Every port in the range ${describeBlock(block)} is in use. Widen it under Admin, Domains, or remove a server that is no longer running.`
    );
}
