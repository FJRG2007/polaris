/**
 * Whether an address being added is a Polaris already on the list under another
 * name - `polaris.local` next to `polaris.example.com`.
 *
 * Settled by the instance's signature (`findSameInstance` in
 * `@polaris/core/instance-fallback`), never by the name. Each listed server is
 * asked who it is over its own address; the typed one must then sign a fresh
 * nonce with that key. A browser cannot read past a certificate it does not
 * trust, so when the address itself does not answer the same host is asked
 * without TLS as well: only the public describe and challenge routes, with no
 * cookie and no token, and the answer is used for the comparison alone.
 *
 * Answers are kept for a short while, so retyping an address asks nothing.
 */

import { plainOrigin } from "@/lib/local-address";
import {
    findSameInstance,
    learnInstance,
    type InstanceRecord,
    type KnownInstance
} from "@polaris/core/instance-fallback";

const CACHE_MS = 30_000;
const TIMEOUT_MS = 4_000;
const ENTRIES = 50;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createSameInstanceCheck(
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    now: () => number = Date.now
) {
    const records = new Map<
        string,
        { readonly record: InstanceRecord | null; readonly until: number }
    >();
    const answers = new Map<string, { readonly same: string | null; readonly until: number }>();

    const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
        if (map.size >= ENTRIES) map.delete(map.keys().next().value!);
        map.set(key, value);
    };

    const recordOf = async (origin: string): Promise<InstanceRecord | null> => {
        const held = records.get(origin);
        if (held && held.until > now()) return held.record;
        const record = await learnInstance(origin, fetchImpl, TIMEOUT_MS);
        remember(records, origin, { record, until: now() + CACHE_MS });
        return record;
    };

    /** The listed origin `origin` proves it is, or null. */
    return async (origin: string, listed: readonly string[]): Promise<string | null> => {
        const key = `${origin} ${listed.join(" ")}`;
        const held = answers.get(key);
        if (held && held.until > now()) return held.same;
        const others = listed.filter((one) => one !== origin);
        const learned = await Promise.all(others.map(recordOf));
        const known: KnownInstance[] = others.flatMap((one, index) => {
            const record = learned[index];
            return record ? [{ origin: one, record }] : [];
        });
        const plain = plainOrigin(origin);
        const ways = plain ? [origin, plain] : [origin];
        const same = (await findSameInstance(ways, known, fetchImpl, TIMEOUT_MS))?.origin ?? null;
        remember(answers, key, { same, until: now() + CACHE_MS });
        return same;
    };
}
