/**
 * The way back to this Polaris when its domain stops answering. While the domain
 * works a tab remembers who the instance is and where else it answers, the same
 * record the apps keep; when it stops, each other address is challenged and only a
 * proven one, or a local one that could not be asked, is offered.
 *
 * Nothing is sent to an address but a nonce, and going there is the reader's own
 * click. Sign-in does not carry over: a session belongs to the address it began on.
 * `public/offline.html` makes the same offer by the same rules, in a script of its
 * own, since no bundle can be counted on while the domain is down;
 * `test/app/offline-page.test.ts` holds the two together.
 */

import {
    learnInstance,
    readInstance,
    RELEARN_MS,
    verifyAlternate,
    type InstanceRecord
} from "@polaris/core/instance-fallback";

/** Also read by `public/offline.html`, which has no access to anything else. */
export const INSTANCE_KEY = "polaris.instance";

const LOCAL_CHALLENGE_MS = 3_000;
const LOCAL_HOST =
    /(\.local|^10\.\d+\.\d+\.\d+|^192\.168\.\d+\.\d+|^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

/** An address to offer, and whether it proved it is this Polaris. */
export interface LocalOffer {
    readonly origin: string;
    readonly proven: boolean;
}

interface Stored {
    readonly record: unknown;
    readonly at: number;
}

function read(): { record: InstanceRecord; at: number } | null {
    try {
        const raw = window.localStorage.getItem(INSTANCE_KEY) ?? "null";
        const stored = JSON.parse(raw) as Stored | null;
        const record = readInstance(stored?.record);
        return record && typeof stored?.at === "number" ? { record, at: stored.at } : null;
    } catch {
        return null;
    }
}

/** Learns the instance over this address, which is the one the reader trusts. */
export async function rememberInstance(): Promise<void> {
    const held = read();
    if (held && Date.now() - held.at < RELEARN_MS) return;
    const record = await learnInstance(window.location.origin);
    if (!record) return;
    try {
        window.localStorage.setItem(INSTANCE_KEY, JSON.stringify({ record, at: Date.now() }));
    } catch {
        // Without room to remember it, there is simply no offer later.
    }
}

export function isLocalOrigin(origin: string): boolean {
    return LOCAL_HOST.test(new URL(origin).hostname);
}

/**
 * Where the offer leads. The address the reader is on can itself be a credential,
 * so it goes only to a proven address; any other gets its front door.
 */
export function offerHref({ origin, proven }: LocalOffer): string {
    return proven ? `${origin}${window.location.pathname}${window.location.search}` : origin;
}

/**
 * The address to offer, or null. A local address that could not be asked still
 * counts: a browser refuses to read from a certificate it does not know, while the
 * reader can open it and decide. An address that answered with another key never does.
 */
export async function findLocalAddress(): Promise<LocalOffer | null> {
    const held = read();
    if (!held) return null;
    const others = held.record.addresses.filter((origin) => origin !== window.location.origin);
    const verdicts = await Promise.all(
        others.map(async (origin) => ({
            origin,
            verdict: await verifyAlternate(origin, held.record, undefined, LOCAL_CHALLENGE_MS)
        }))
    );
    const proven = verdicts.find(({ verdict }) => verdict.kind === "same");
    const unasked = verdicts.find(
        ({ origin, verdict }) => verdict.kind === "unreachable" && isLocalOrigin(origin)
    );
    if (proven) return { origin: proven.origin, proven: true };
    return unasked ? { origin: unasked.origin, proven: false } : null;
}
