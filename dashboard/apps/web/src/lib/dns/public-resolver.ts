/**
 * A resolver that asks the big public resolvers by name, and nobody else.
 *
 * Every check that has to see what the internet sees - a mail domain's records,
 * the reverse name of a mail server, a domain's security audit - asks these two
 * rather than this machine's own resolver, which may answer from a cache or for
 * a split-horizon name nobody outside can look up. Two operators, so one having
 * a bad day is not the answer. Its own module so a caller does not pull in
 * everything the mail server's DNS code needs to reach it.
 */

import { Resolver } from "node:dns/promises";

const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

export function publicResolver(): Resolver {
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers(PUBLIC_RESOLVERS);
    return resolver;
}

/**
 * A CAA answer's tag and value. Node gives each record as an object keyed by its
 * tag (`{ critical: 0, issue: "letsencrypt.org" }`) and, depending on the
 * version, a `type: "CAA"` beside it - which is not the tag, and reading the
 * first key that is not `critical` picked it up instead.
 */
export function caaTagValue(entry: object): { tag: string; value: string } {
    const found = Object.entries(entry).find(([key]) => key !== "critical" && key !== "type");
    return found ? { tag: found[0].toLowerCase(), value: String(found[1]) } : { tag: "", value: "" };
}
