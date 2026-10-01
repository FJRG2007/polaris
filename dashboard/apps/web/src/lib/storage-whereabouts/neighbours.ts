/**
 * The host's neighbour table: which hardware address answered for which IP.
 *
 * Neither the web container nor the host daemon can read it. Both sit on Docker
 * bridges, so their own tables list the bridge gateway and nothing on the LAN.
 * The one part of Polaris on the host's network is the mDNS responder - it has to
 * be, multicast does not cross a bridge - and `/proc/net/arp` read from inside it
 * is the host's table. So the daemon is asked to run one read-only `awk` there,
 * through the same exec it runs a database statement with.
 *
 * Returns nothing rather than failing where that is not possible (the limited
 * edition has no daemon; an install without the responder has no host-network
 * container): a storage's identity is then its SMB answer alone.
 *
 * Server-only.
 */

import { normalizeMac } from "./identity";
import { HostdClient } from "@polaris/hostd-client";

/** The responder, by its compose labels: its name changes on every recreate. */
const RESPONDER_FILTER = encodeURIComponent(
    JSON.stringify({
        label: ["com.docker.compose.project=polaris", "com.docker.compose.service=mdns"],
        status: ["running"]
    })
);

/**
 * `/proc/net/arp` reduced to address, flags and hardware address per line.
 *
 * Reduced in the container rather than here because the daemon cuts what an exec
 * says at 16 KB, and a full /24 in the kernel's own layout is past that.
 */
const READ_TABLE = ["awk", "NR > 1 { print $1, $3, $4 }", "/proc/net/arp"];

/** IP address -> hardware address, complete entries only. */
export type NeighbourTable = ReadonlyMap<string, string>;

/**
 * The lines `READ_TABLE` prints, as a table. An entry whose flags lack
 * ATF_COM (0x2) is one the kernel is still asking about or has given up on -
 * "INCOMPLETE" in `ip neigh` - and its all-zero address means nothing.
 */
export function parseNeighbourTable(output: string): Map<string, string> {
    const table = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
        const [address, flags, hardware] = line.trim().split(/\s+/);
        if (!address || !flags || !hardware) continue;
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) continue;
        const value = Number.parseInt(flags, 16);
        if (!Number.isFinite(value) || (value & 0x2) === 0) continue;
        const mac = normalizeMac(hardware);
        if (mac) table.set(address, mac);
    }
    return table;
}

/** Read the host's neighbour table, or an empty one when it cannot be read. */
export async function readNeighbourTable(client = new HostdClient()): Promise<NeighbourTable> {
    try {
        const listing = await client.dockerRequest(
            "GET",
            `/containers/json?filters=${RESPONDER_FILTER}`
        );
        if (listing.status !== 200) return new Map();
        const parsed = JSON.parse(listing.body) as unknown;
        const first = Array.isArray(parsed)
            ? (parsed[0] as { Id?: unknown } | undefined)
            : undefined;
        if (typeof first?.Id !== "string") return new Map();
        const run = await client.execRun(first.Id, [...READ_TABLE]);
        if (run.code !== 0) return new Map();
        return parseNeighbourTable(run.output);
    } catch {
        return new Map();
    }
}
