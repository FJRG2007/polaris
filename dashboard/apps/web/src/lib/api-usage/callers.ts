/**
 * Who called with a set of keys over a window: the program families and the
 * addresses, summed from the hourly caller rows (ApiKeyCallerHour) through the
 * primary key (key first, hour second), the way the route figures are.
 *
 * Addresses leave here masked - an IPv4 address to its /24, an IPv6 one to its
 * /48, the prefixes analytics tools anonymize to - unless the owner asked to see
 * them in full. Calls from hours before callers were recorded have no rows; what
 * the route rollup counted beyond the `recorded` sum is the report's `unrecorded`.
 */

import { isIPv4, isIPv6 } from "node:net";
import { prisma } from "@polaris/db";
import { NO_ADDRESS, OTHER_ADDRESSES } from "./recorder";

/** The most families and addresses a report lists. */
export const CALLER_ROWS = 50;

export interface CallerShare {
    /** The family (`clientFamily`), or the address - masked unless revealed. */
    name: string;
    calls: number;
    errors: number;
}

export interface CallerReport {
    clients: CallerShare[];
    addresses: CallerShare[];
    /** Calls the caller rows hold for the window, listed or not. */
    recorded: number;
}

/** An IPv6 address as its eight groups, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
    if (!isIPv6(address)) return null;
    const bare = address.split("%")[0]!;
    const [head, tail] = bare.includes("::") ? bare.split("::") : [bare, undefined];
    const part = (text: string | undefined) => {
        if (!text) return [] as number[];
        const groups: number[] = [];
        for (const piece of text.split(":")) {
            if (piece.includes(".")) {
                const octets = piece.split(".").map(Number);
                groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
            } else groups.push(parseInt(piece, 16));
        }
        return groups;
    };
    const left = part(head);
    const right = part(tail);
    const fill = tail === undefined ? 0 : 8 - left.length - right.length;
    return [...left, ...new Array<number>(fill).fill(0), ...right];
}

/**
 * An address cut down to its network: `203.0.113.0/24`, `2001:db8:1::/48`. An
 * IPv4 address written as IPv6 (`::ffff:203.0.113.7`) is masked as the IPv4 one
 * it is. Anything that is not an address - the header is the caller's to write
 * - is returned as it came.
 */
export function maskAddress(address: string): string {
    if (isIPv4(address)) return `${address.split(".").slice(0, 3).join(".")}.0/24`;
    const groups = ipv6Groups(address);
    if (!groups) return address;
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
        const v4 = [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8];
        return `${v4.join(".")}.0/24`;
    }
    const prefix = groups.slice(0, 3).map((group) => group.toString(16));
    while (prefix.length > 0 && prefix[prefix.length - 1] === "0") prefix.pop();
    return `${prefix.join(":")}::/48`;
}

export async function callerReport(
    keyIds: readonly string[],
    since: Date,
    options: { reveal?: boolean } = {}
): Promise<CallerReport> {
    const where = {
        apiKeyId: keyIds.length === 1 ? keyIds[0]! : { in: [...keyIds] },
        hour: { gte: since }
    };
    const [all, byClient, byAddress] = await Promise.all([
        prisma.apiKeyCallerHour.aggregate({ where, _sum: { calls: true } }),
        prisma.apiKeyCallerHour.groupBy({
            by: ["client"],
            where,
            _sum: { calls: true, errors: true },
            orderBy: [{ _sum: { calls: "desc" } }, { client: "asc" }],
            take: CALLER_ROWS
        }),
        prisma.apiKeyCallerHour.groupBy({
            by: ["ip"],
            where,
            _sum: { calls: true, errors: true },
            orderBy: [{ _sum: { calls: "desc" } }, { ip: "asc" }],
            take: CALLER_ROWS
        })
    ]);
    const share = (name: string, sums: { calls: number | null; errors: number | null }) => ({
        name,
        calls: sums.calls ?? 0,
        errors: sums.errors ?? 0
    });
    return {
        clients: byClient.map((row) => share(row.client, row._sum)),
        addresses: byAddress.map((row) =>
            share(options.reveal || row.ip === NO_ADDRESS || row.ip === OTHER_ADDRESSES ? row.ip : maskAddress(row.ip), row._sum)
        ),
        recorded: all._sum.calls ?? 0
    };
}
