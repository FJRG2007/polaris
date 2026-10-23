/**
 * What a zone's own nameservers answer for a name, as opposed to what a public
 * resolver still has cached.
 *
 * Right after a record is repointed the public resolvers keep answering the old
 * address until their copy's TTL runs out. Asking the zone's nameservers tells
 * "the record is wrong" apart from "the record is right and the world has not
 * caught up yet", which is a different sentence on the screen.
 */

import { Resolver } from "node:dns/promises";

/** Public resolvers asked for the nameservers and for what the world sees. */
export const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"] as const;

/** The nameservers of the closest zone at or above `name`, found by walking up its labels. */
async function nameserversOf(name: string): Promise<string[]> {
    const labels = name.replace(/^\*\./, "").split(".");
    for (let index = 0; index < labels.length - 1; index += 1) {
        const found = await resolverAt(PUBLIC_RESOLVERS)
            .resolveNs(labels.slice(index).join("."))
            .catch(() => [] as string[]);
        if (found.length > 0) return found;
    }
    return [];
}

function resolverAt(servers: readonly string[]): Resolver {
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers([...servers]);
    return resolver;
}

/** The A records a name has, with their TTL, as the zone's own nameservers hold
 *  them. Null when the nameservers could not be found or asked. */
export async function authoritativeA(
    name: string
): Promise<{ addresses: string[]; ttl: number } | null> {
    try {
        const nameservers = await nameserversOf(name);
        const addresses = (
            await Promise.all(
                nameservers.slice(0, 2).map((ns) =>
                    resolverAt(PUBLIC_RESOLVERS)
                        .resolve4(ns)
                        .catch(() => [])
                )
            )
        ).flat();
        if (addresses.length === 0) return null;
        const answer = await resolverAt(addresses).resolve4(name, { ttl: true });
        return {
            addresses: answer.map((entry) => entry.address),
            ttl: Math.max(0, ...answer.map((entry) => entry.ttl))
        };
    } catch {
        return null;
    }
}

/** What the public resolvers answer for a name right now, every address either
 *  of them gave. Empty when neither answered. */
export async function publicA(name: string): Promise<string[]> {
    const answers = await Promise.all(
        PUBLIC_RESOLVERS.map((server) =>
            resolverAt([server])
                .resolve4(name)
                .catch(() => [] as string[])
        )
    );
    return [...new Set(answers.flat())];
}

/**
 * Whether names that still resolve to another address are only waiting on caches:
 * the zone's own nameservers answer this server and nothing else. Answers the
 * seconds left (the record's TTL, the longest a cached copy can live), or null when
 * the records themselves are wrong or could not be asked.
 */
export function propagationLeft(
    authoritative: readonly ({ addresses: string[]; ttl: number } | null)[],
    expectedIp: string
): number | null {
    if (authoritative.length === 0) return null;
    for (const answer of authoritative) {
        if (!answer || answer.addresses.length === 0) return null;
        if (answer.addresses.some((address) => address !== expectedIp)) return null;
    }
    return Math.max(...authoritative.map((answer) => answer?.ttl ?? 0));
}
