/**
 * How a published port is keyed: the protocol and the number, as one string.
 *
 * Its own module because the registry around it reaches the database, and this
 * is a two-word join used while deciding which ports are free - including by the
 * installable apps, which take it from the host.
 */

import type { PortProtocol } from "@/lib/apps/port-block";

/** A port on one transport. TCP 25565 and UDP 25565 are different doors, and
 *  treating them as one was costing a usable port every time. */
export type PortKey = `${PortProtocol}:${number}`;

export function portKey(port: number, protocol: PortProtocol): PortKey {
    return `${protocol}:${port}`;
}
