/**
 * Picking the ports an ARK server will answer on.
 *
 * Apart from the allocator this is all pure and lives in `config.ts`, which is
 * what the create dialog renders from. This half is the one that has to look at
 * what every other server on this Polaris already took.
 */

import { availableHostPortRun } from "@/lib/apps/port-registry";
import { ARK_PORT_RUN, arkPortsFrom, PREFERRED_GAME_PORT, type ArkPorts } from "@/lib/apps/ark/config";

/**
 * Three consecutive free ports, so the pair that has to be adjacent is.
 *
 * One call rather than three: nothing is recorded until the application exists, so
 * three separate allocations would each be handed the same port.
 */
export async function allocateArkPorts(): Promise<ArkPorts> {
    return arkPortsFrom(await availableHostPortRun(PREFERRED_GAME_PORT, ARK_PORT_RUN, "udp"));
}
