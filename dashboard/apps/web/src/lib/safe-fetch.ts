/**
 * Fetching an address somebody typed, which is the most dangerous thing a server
 * can be asked to do.
 *
 * Polaris runs on a machine with a LAN around it and, on a hosted box, a
 * metadata service one address away. A naive fetch of a person-supplied URL is a
 * request forgery with a login page in front of it: hand it a link and the
 * server retrieves whatever is behind it from inside the network and hands the
 * result back. Everything here exists because of that:
 *
 * - only http and https, and never a link carrying credentials;
 * - never a hostname that resolves to anything but a public address, and every
 *   address it resolves to is checked, not just the first: a name with two A
 *   records is a name that can answer differently next time;
 * - redirects are followed by hand, one hop at a time, re-checking the address
 *   at every hop. Following them automatically is the classic way past a check
 *   like this - the first hop is example.com and the second is 169.254.169.254;
 * - a timeout and a byte ceiling, so a link to a ten-gigabyte file is a failed
 *   fetch rather than a full disk.
 *
 * This lives on its own rather than inside the link previews it was written for
 * because it is not about link previews: everything that reaches out to an
 * address a person gave us - a preview, a picture posted as a link, a GIF from
 * somewhere else - has to pass exactly these checks, and a second copy of them
 * is a second place for one of them to be missing.
 *
 * Two rules about the plumbing, both learned the hard way and both silent when
 * broken - every request here fails, and a failure looks exactly like a site
 * that would not answer:
 *
 * - **The dispatcher and the fetch come from the same package.** The runtime's
 *   own `fetch` is built on the undici it ships with, and it refuses an `Agent`
 *   built by the one in `node_modules` ("invalid onError method"). So this calls
 *   undici's `fetch` rather than the global one, which is the only way the two
 *   halves are the same version.
 * - **A custom resolver has to answer the question it was asked.** Node asks for
 *   every address at once while it is happy-eyeballing (`options.all`) and for
 *   one otherwise; handing back a single address to the first form is an
 *   "Invalid IP address: undefined" at connect time.
 */

import * as core from "@polaris/core";
import { lookup } from "node:dns/promises";
import { Agent, fetch as guardedFetch } from "undici";
import { createGate, createSharedFlight, deadline } from "@/lib/concurrency-gate";

/** What undici's fetch answers with. Named off the function so this cannot drift
 *  from the version installed. */
type GuardedResponse = Awaited<ReturnType<typeof guardedFetch>>;

/** How long Polaris waits for an answer before giving up. */
export const FETCH_TIMEOUT_MS = 5000;

/** How many redirects are followed. Enough for the ordinary http-to-https and a
 *  canonical host, and not enough to be walked around a network. */
const MAX_HOPS = 3;

/**
 * How many name lookups for outside addresses may run at once.
 *
 * `dns.lookup` is `getaddrinfo`, and Node runs it on libuv's thread pool - four
 * threads by default, shared with everything else in the process that is not
 * plain network I/O: signing and checking the session cookie, compressing a
 * response, reading a file. A name that does not answer holds its thread for the
 * resolver's whole timeout. The Mail list asks for a sender's mark per row, each
 * of those tries up to three hosts, and a screenful of senders was enough to put
 * every thread in the pool on a slow lookup at once - after which every page in
 * Polaris, for every user, waited behind them. From the browser that is a click
 * on another app that does nothing until the page is reloaded.
 *
 * Two, so at least two threads are always left for serving pages.
 */
const LOOKUP_SLOTS = 2;

const lookups = createGate(LOOKUP_SLOTS);
const sameName = createSharedFlight<VettedAddress[]>();

/**
 * Every address a name answers with, through the gate above.
 *
 * The same name asked twice while the first lookup is out is one lookup - which
 * is also what the check and the connect below are for a single fetch. Gives up
 * waiting after `FETCH_TIMEOUT_MS`; a lookup already running keeps its slot until
 * it finishes, which is exactly the bound the gate exists to keep, and one still
 * in line when its last caller gives up leaves the line instead of running for
 * nobody.
 */
export async function resolveName(hostname: string): Promise<VettedAddress[]> {
    const wait = deadline(FETCH_TIMEOUT_MS, `${hostname} took too long to resolve`);
    try {
        return await sameName(
            hostname.toLowerCase(),
            (abandoned) =>
                lookups.run(async () => {
                    const found = await lookup(hostname, { all: true });
                    return found.map((entry) => ({ address: entry.address, family: entry.family }));
                }, abandoned),
            wait.signal
        );
    } finally {
        wait.clear();
    }
}

/** An address Polaris is willing to consider at all. */
export function safeUrl(address: string): URL | null {
    if (address.length > core.MAX_LINK_LENGTH) return null;
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Credentials in a link being fetched by the server are somebody's password
    // being handed to whatever is on the other end.
    if (url.username || url.password) return null;
    return url;
}

/**
 * Whether a hostname points anywhere Polaris is allowed to go.
 *
 * Every resolved address has to be public, not merely the first: a name with an
 * A record for a real host and another for 127.0.0.1 would otherwise pass and
 * then connect to whichever the stack picked.
 */
export async function reachable(hostname: string): Promise<boolean> {
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (core.isIpAddress(bare)) return !core.isPrivateIp(bare);

    try {
        const addresses = await resolveName(bare);
        if (addresses.length === 0) return false;
        return addresses.every((entry) => !core.isPrivateIp(entry.address));
    } catch {
        // A name that does not resolve is a name not to fetch. On a machine with
        // no resolver at all this refuses everything, which is the right way to
        // be wrong.
        return false;
    }
}

/**
 * The dispatcher every fetch here connects through.
 *
 * The check and the connection share one resolution. `reachable` above is a fast
 * refusal, but on its own it cannot be the whole guard: it resolves the name, and
 * then `fetch` resolves it a second time to open the socket - two independent
 * lookups of the same name. A name that answers a public address to the check and
 * a private one to the connect (DNS rebinding) slips between them. So the same
 * rule is enforced *inside the connector*, where the address that is validated is
 * the exact one the socket opens to: the name is resolved once, refused when any
 * address it answers with is private, and connected to the address just checked.
 * The hostname is left untouched for TLS, so certificate verification is
 * unaffected.
 */
/** One address a socket may be opened to. */
export interface VettedAddress {
    readonly address: string;
    readonly family: number;
}

/**
 * Every address a connection may open to, or an error when the name may not be
 * reached at all.
 *
 * The rule is `reachable`'s, applied at the moment of connecting rather than a
 * moment before it: every address the name answers with has to be public, not
 * merely the first the stack would pick, so one private answer refuses the whole
 * name. Pulled out on its own so the check at the point of the socket can be read
 * and tested as the plain decision it is.
 *
 * The whole list comes back rather than one of them because that is what Node
 * asks for while it is happy-eyeballing, and because a host with eight addresses
 * should not be unreachable when the first is having a bad afternoon. They have
 * all passed the same check, so handing over any of them is the same decision.
 */
export function vettedAddresses(
    hostname: string,
    addresses: readonly VettedAddress[]
): VettedAddress[] | Error {
    if (addresses.length === 0) return new Error(`${hostname} does not resolve`);
    if (addresses.some((entry) => core.isPrivateIp(entry.address))) {
        return new Error(`${hostname} resolves to a private address`);
    }
    return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

const dispatcher = new Agent({
    connect: {
        lookup(hostname, options, callback) {
            resolveName(hostname).then(
                (addresses) => {
                    const vetted = vettedAddresses(hostname, addresses);
                    if (vetted instanceof Error) return callback(vetted, "", 0);
                    // Answered in the shape it was asked in. `all` is what a
                    // socket opening with happy eyeballs wants, and the single
                    // address is what everything else does.
                    if (options.all) return callback(null, vetted);
                    callback(null, vetted[0]!.address, vetted[0]!.family);
                },
                (error: Error) => callback(error as NodeJS.ErrnoException, "", 0)
            );
        }
    }
});

/**
 * A body to send with the request, for the callers that are not reading a page
 * but telling a server something - the one-click unsubscribe an RFC 8058 sender
 * publishes is a POST with a form body and nothing else.
 */
export interface SentBody {
    readonly contentType: string;
    readonly body: string;
}

/** Fetch, following redirects by hand and re-checking every hop. */
export async function follow(
    start: URL,
    accept = "text/html,application/xhtml+xml",
    sent?: SentBody
): Promise<GuardedResponse | null> {
    let url = start;
    /** Dropped on the redirects that mean "go and GET this instead". A 301, 302
     *  or 303 answering a POST is every client's cue to stop posting; only 307
     *  and 308 promise the body may be sent again. */
    let posting = Boolean(sent);
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
        if (!(await reachable(url.hostname))) return null;

        let response: GuardedResponse;
        try {
            // The dispatcher re-resolves and re-checks the name as it connects, so
            // the address vetted a line ago cannot be swapped for a private one
            // underneath the fetch.
            const init = {
                redirect: "manual" as const,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                dispatcher,
                headers: {
                    // Named honestly, in the form crawlers are conventionally
                    // named: `Mozilla/5.0 (compatible; <name>)`, the same shape
                    // Googlebot and every link-preview bot uses. A server that
                    // does not want to be fetched by us can still say so, and
                    // the one that blocks us is not left guessing what we were -
                    // but a bare product name gets served a cut-down page by the
                    // large sites, which is how a YouTube link ended up with no
                    // thumbnail and no channel on the card.
                    "user-agent": "Mozilla/5.0 (compatible; PolarisBot/1.0; +link preview)",
                    accept,
                    ...(posting && sent ? { "content-type": sent.contentType } : {})
                },
                ...(posting && sent ? { method: "POST", body: sent.body } : {})
            };
            response = await guardedFetch(url, init);
        } catch {
            return null;
        }

        if (response.status < 300 || response.status >= 400) return response;

        const next = response.headers.get("location");
        if (!next) return response;
        if (response.status !== 307 && response.status !== 308) posting = false;
        try {
            url = new URL(next, url);
        } catch {
            return null;
        }
        const checked = safeUrl(url.href);
        if (!checked) return null;
        url = checked;
    }
    return null;
}

/** Read at most `maxBytes`, whatever the other end says it is sending. */
export async function readCapped(
    response: GuardedResponse,
    maxBytes: number
): Promise<Uint8Array | null> {
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > maxBytes) return null;

    const reader = response.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    return bytes;
}

/**
 * Read up to `maxBytes` and keep what arrived, rather than refusing the lot.
 *
 * For a document that is being read for its head, a cut-off copy is still the
 * answer - the ceiling is there to bound what a link can cost us, not to say the
 * page was too long to look at. `readCapped` is the other rule and the right one
 * for a picture or a JSON document, where half the bytes are not half the thing.
 */
export async function readAtMost(
    response: GuardedResponse,
    maxBytes: number
): Promise<Uint8Array | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.length;
        if (total >= maxBytes) {
            await reader.cancel().catch(() => undefined);
            break;
        }
    }

    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    return bytes.subarray(0, maxBytes);
}

/** A picture fetched from an address somebody gave us, or null when there is
 *  nothing there, it is not a picture, or it is bigger than allowed. */
export async function fetchImage(
    address: string,
    maxBytes: number
): Promise<{ name: string; contentType: string; bytes: Uint8Array } | null> {
    const url = safeUrl(address);
    if (!url) return null;

    const response = await follow(url, "image/*");
    if (!response?.ok) return null;

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!contentType.startsWith("image/")) return null;

    const bytes = await readCapped(response, maxBytes);
    if (!bytes) return null;

    // The last part of the path, when there is one worth having. A name is only
    // a label on a file here; the type above is what decides how it is treated.
    const name = url.pathname.split("/").pop() || "picture";
    return { name: name.slice(0, 120), contentType, bytes };
}
