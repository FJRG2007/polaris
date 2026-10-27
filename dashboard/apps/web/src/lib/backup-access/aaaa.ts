/**
 * The AAAA records, the pure half: when this server's IPv6 is published, and
 * which record writes that takes.
 *
 * A line behind a carrier NAT can still hold a public IPv6 (Starlink hands one
 * out), and IPv6 visitors can then reach the house directly. Only an address a
 * check from outside got into is published - the router's firewall may drop
 * inbound - and one that stops answering is removed only after several checks in
 * a row, so one lost probe does not take the record down.
 */

import { z } from "zod";
import { planAaaa } from "./inbound";

export const AAAA_KEY = "network.aaaa";

/** Failed checks in a row before a published address is withdrawn. */
export const AAAA_FAILS_TO_REMOVE = 3;

/** Addresses remembered as written by Polaris, newest first. */
const WRITTEN_LIMIT = 10;

export const aaaaStateSchema = z.object({
    /** The address the records hold now, or null. */
    published: z.string().nullable(),
    /** Failed or missing checks in a row while one is published. */
    fails: z.number().int().min(0),
    /** Every address Polaris wrote, so a record of the operator's is never touched. */
    written: z.array(z.string()).max(WRITTEN_LIMIT),
    /** Why the address could not be published: no Cloudflare account to write
     *  with (another provider has no API here), or the writes failed. */
    problem: z.enum(["no-cloudflare", "failed"]).nullable().default(null)
});
export type AaaaState = z.infer<typeof aaaaStateSchema>;

export const EMPTY_AAAA: AaaaState = { published: null, fails: 0, written: [], problem: null };

/**
 * One spelling per IPv6 address (lower case, zeros compressed), so the address
 * the responder wrote and the one Cloudflare hands back compare equal. Null for
 * anything that is not an IPv6 address.
 */
export function canonicalIpv6(value: string): string | null {
    try {
        const host = new URL(`http://[${value.trim()}]/`).hostname;
        return host.slice(1, -1);
    } catch {
        return null;
    }
}

const canonical = (value: string): string => canonicalIpv6(value) ?? value.toLowerCase();

export function readAaaaState(raw: string | null): AaaaState {
    if (!raw) return EMPTY_AAAA;
    try {
        const parsed = aaaaStateSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : EMPTY_AAAA;
    } catch {
        return EMPTY_AAAA;
    }
}

/**
 * The next state from one check. `inbound` is null when nothing could check
 * (no outside machine, or it did not answer): that neither publishes nor counts
 * against an address already published.
 */
export function nextAaaa(
    previous: AaaaState,
    input: { readonly ipv6: string | null; readonly inbound: boolean | null }
): AaaaState {
    const found = planAaaa({ ipv6: input.ipv6, ipv6Inbound: input.inbound });
    const ready = found ? canonical(found) : null;
    if (ready) {
        const written = [ready, ...previous.written.filter((entry) => entry !== ready)].slice(
            0,
            WRITTEN_LIMIT
        );
        return { published: ready, fails: 0, written, problem: null };
    }
    if (!previous.published) return { ...previous, fails: 0 };
    const same = input.ipv6 !== null && canonical(input.ipv6) === previous.published;
    if (input.inbound === null && same) return previous;
    const fails = previous.fails + 1;
    if (fails < AAAA_FAILS_TO_REMOVE) return { ...previous, fails };
    return { ...previous, published: null, fails: 0 };
}

export interface NameRecord {
    readonly id: string;
    readonly type: string;
    readonly content: string;
    readonly proxied: boolean;
}

export type AaaaOp =
    | { readonly kind: "create"; readonly content: string }
    | { readonly kind: "repoint"; readonly id: string; readonly content: string }
    | { readonly kind: "delete"; readonly id: string };

/**
 * The writes that bring one name's AAAA records to `want` (null: none of ours).
 *
 * Only AAAA records holding an address Polaris wrote are edited or removed. A
 * name with an AAAA of somebody else's is left alone, a CNAME (a tunnel) cannot
 * sit beside one at all, and a name behind Cloudflare's proxy already answers
 * IPv6 visitors - an unproxied AAAA there would only bypass the proxy.
 */
export function planAaaaRecords(
    records: readonly NameRecord[],
    want: string | null,
    written: readonly string[]
): AaaaOp[] {
    const mine = new Set(written.map(canonical));
    const aaaa = records.filter((record) => record.type === "AAAA");
    const ours = aaaa.filter((record) => mine.has(canonical(record.content)));
    const foreign = aaaa.length > ours.length;
    const blocked =
        records.some((record) => record.type === "CNAME") ||
        records.some((record) => record.type === "A" && record.proxied);
    const target = want && !blocked && !foreign ? canonical(want) : null;
    if (!target) return ours.map((record) => ({ kind: "delete", id: record.id }));
    const keep = ours.find((record) => canonical(record.content) === target) ?? ours[0];
    const ops: AaaaOp[] = ours
        .filter((record) => record !== keep)
        .map((record) => ({ kind: "delete", id: record.id }));
    if (!keep) ops.push({ kind: "create", content: target });
    else if (canonical(keep.content) !== target)
        ops.push({ kind: "repoint", id: keep.id, content: target });
    return ops;
}
