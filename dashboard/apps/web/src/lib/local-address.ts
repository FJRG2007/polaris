/**
 * The way back to this Polaris when its domain stops answering. While the domain
 * works a tab remembers who the instance is and where else it answers, the same
 * record the apps keep; when it stops, each other address is challenged and only a
 * proven one, or a local one that could not be asked, is offered.
 *
 * Nothing is sent to an address but a nonce, and going there is the reader's own
 * click. An address served with the local CA's certificate is never asked at all:
 * once a reader has clicked through that certificate, Chrome lets a fetch to it run
 * and then marks the page that made it "Not secure" for mixed content with
 * certificate errors - every page of the public domain, for the rest of the visit
 * (Chromium tracks such subresources per page, crbug.com/634171,
 * https://codereview.chromium.org/2226523002). Such an address is
 * offered unproven instead, and the one this Polaris names under its own domain with
 * a public certificate (`lib/lan-hostname.ts`) is the one asked. Sign-in does not carry over: a session belongs to the address it began on.
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
/** The name `lib/lan-hostname.ts` gives the LAN address under the operator's own
 *  domain: local to the reader, but on a public certificate. */
const LAN_NAME = /^lan-\d{1,3}(-\d{1,3}){3}\./;

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

/** An address on the reader's own network, by either kind of name. */
export function isLocalOrigin(origin: string): boolean {
    const host = new URL(origin).hostname;
    return LOCAL_HOST.test(host) || LAN_NAME.test(host);
}

/** An address whose certificate only the local CA vouches for: never fetched from a
 *  page, since a click-through on it taints the page that asks. */
export function onLocalCertificate(origin: string): boolean {
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
 * The address to offer, or null. Only an address on a public certificate is asked;
 * a local-certificate one is offered as it stands, its front door only, for the
 * reader to open and decide. An address that answered with another key never is.
 * A LAN name the reader's resolver refuses (a router's DNS rebinding protection drops
 * public names that resolve to private addresses) simply does not answer, and the
 * local-certificate address is offered in its place.
 */
export async function findLocalAddress(): Promise<LocalOffer | null> {
    const held = read();
    if (!held) return null;
    const others = held.record.addresses.filter((origin) => origin !== window.location.origin);
    const asked = others.filter((origin) => !onLocalCertificate(origin));
    const verdicts = await Promise.all(
        asked.map(async (origin) => ({
            origin,
            verdict: await verifyAlternate(origin, held.record, undefined, LOCAL_CHALLENGE_MS)
        }))
    );
    const proven =
        verdicts.find(({ origin, verdict }) => verdict.kind === "same" && isLocalOrigin(origin)) ??
        verdicts.find(({ verdict }) => verdict.kind === "same");
    if (proven) return { origin: proven.origin, proven: true };
    const unasked = others.find(onLocalCertificate);
    return unasked ? { origin: unasked, proven: false } : null;
}
