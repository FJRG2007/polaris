/**
 * The private network a Code session's container joins on this box. Kept apart
 * from `session-container` so the deploy side, which keeps these networks
 * wanted, does not load the container machinery to name one.
 */

import { serviceNetwork } from "@polaris/deploy";
import { getCapabilities } from "@polaris/config";

/**
 * The private network a container session joins, so Polaris can dial its web
 * servers by name for the preview (`session-preview`) and no other session can.
 * One of the daemon's service-scoped private networks: it attaches Polaris's
 * own containers to those, and prunes one once nothing but them is on it.
 */
export function sessionNetwork(sessionId: string): string {
    return serviceNetwork(`agent-session:${sessionId}`);
}

/**
 * The networks a session's container joins where it is going.
 *
 * Only on this box, where Polaris is itself a container and reaches another
 * only over a network both are on. On a pool server the preview is dialled from
 * that server, which reaches the container on its own network already, so a
 * network per session there would only be one more left behind. And only when
 * the box's daemon makes private networks: an older one would hand compose a
 * network that does not exist.
 */
export function sessionNetworks(target: { id: string; hostId: string | null }): string[] {
    if (target.hostId || !getCapabilities().privateNetworks) return [];
    return [sessionNetwork(target.id)];
}
