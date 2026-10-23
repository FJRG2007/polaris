/**
 * Reaching the same Polaris on another address when its usual one stops answering.
 *
 * A client is pointed at one address - usually the public domain. When the house
 * loses its internet connection that domain stops answering, while the very same
 * Polaris is still one hop away on `polaris.local` or its LAN address. This module
 * lets a client use that address instead, without ever handing its credential to a
 * machine that only claims to be the same Polaris.
 *
 * The technique is the one Home Assistant's companion app (internal vs external
 * URL) and Plex (a server's `machineIdentifier` plus a signed certificate) settled
 * on, with the identity proven by a signature rather than trusted on sight:
 *
 * 1. Over the address the client already trusts, it learns the instance's id, its
 *    Ed25519 public key and the other addresses it answers on (`GET /api/instance`).
 * 2. Before it uses one of those other addresses, it sends a fresh nonce there and
 *    checks the answer is signed by the key it stored, over that nonce and that
 *    address. An id alone proves nothing - anybody on the LAN can repeat it.
 * 3. Only then does a request carrying the credential go there. An address that
 *    signs with another key, or not at all, never sees the credential.
 *
 * Deliberately dependency-free, Web APIs only (fetch, WebCrypto Ed25519): it is
 * bundled into the browser extension, the desktop app, the Stream Deck plugin, the
 * Companion module and the developer CLI, none of which share a `node_modules`.
 */

/** Where an instance describes itself. Public, no credential. */
export const INSTANCE_PATH = "/api/instance";
/** Where an instance signs a client's nonce. Public, no credential. */
export const CHALLENGE_PATH = "/api/instance/challenge";
/** Domain separation for the signed message, so the key signs nothing else. */
export const SIGNATURE_CONTEXT = "polaris-instance-v1";

/** How long an address that worked is used before the usual one is tried again. */
export const DEFAULT_HOLD_MS = 60_000;
/** How long a verified address stays verified before it is challenged again. */
export const DEFAULT_VERIFIED_MS = 10 * 60_000;
/** How long a request to one address may take before the next one is tried. */
export const DEFAULT_TIMEOUT_MS = 8_000;

/** Shown while a client is on an address other than the one it was given. */
export const USING_LOCAL_WORDS = "Using your local network address";

/** What a client keeps about the instance, learned over its trusted address. */
export interface InstanceRecord {
    /** Stable id of this Polaris. Identifies; does not prove. */
    readonly id: string;
    /** Ed25519 public key, raw 32 bytes as base64url. This is what proves. */
    readonly publicKey: string;
    /** Every origin the instance says it answers on, the usual one included. */
    readonly addresses: readonly string[];
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const MAX_ADDRESSES = 16;

/** An `http(s)` origin with no path, or null. */
export function readOrigin(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 300) return null;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        if (url.username || url.password) return null;
        return url.origin;
    } catch {
        return null;
    }
}

/**
 * Read what `GET /api/instance` answered, or null when it is not one. Strict: an
 * answer with a malformed id or key is refused whole rather than half-kept.
 */
export function readInstance(body: unknown): InstanceRecord | null {
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;
    const id = record["id"];
    const publicKey = record["publicKey"];
    const addresses = record["addresses"];
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    if (typeof publicKey !== "string" || !KEY_PATTERN.test(publicKey)) return null;
    if (!Array.isArray(addresses) || addresses.length > MAX_ADDRESSES) return null;
    const origins: string[] = [];
    for (const one of addresses) {
        const origin = readOrigin(one);
        if (!origin) return null;
        if (!origins.includes(origin)) origins.push(origin);
    }
    return { id, publicKey, addresses: origins };
}

/** The bytes the instance signs: context, id, origin and nonce, one per line. */
export function challengeMessage(id: string, origin: string, nonce: string): string {
    return `${SIGNATURE_CONTEXT}\n${id}\n${origin}\n${nonce}`;
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh 32-byte nonce, base64url. */
export function freshNonce(): string {
    return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** Whether `signature` is the instance's signature over this challenge. Never throws. */
export async function verifyChallenge(
    record: InstanceRecord,
    origin: string,
    nonce: string,
    signature: unknown
): Promise<boolean> {
    if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) return false;
    try {
        const key = await globalThis.crypto.subtle.importKey(
            "raw",
            fromBase64Url(record.publicKey),
            { name: "Ed25519" },
            false,
            ["verify"]
        );
        const message = new TextEncoder().encode(challengeMessage(record.id, origin, nonce));
        return await globalThis.crypto.subtle.verify(
            { name: "Ed25519" },
            key,
            fromBase64Url(signature),
            message
        );
    } catch {
        return false;
    }
}

/** The certificate errors Node reports; a browser reports none, only a TypeError. */
const CERTIFICATE_CODES = new Set([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_UNTRUSTED"
]);

/** Whether a thrown fetch error was a certificate this client does not trust. */
export function isCertificateFailure(caught: unknown): boolean {
    let current: unknown = caught;
    for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === "string" && CERTIFICATE_CODES.has(code)) return true;
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

/**
 * Whether a status means the address did not really answer: a gateway or tunnel
 * in front of a Polaris it cannot reach (a tunnel answers 530 when the house is
 * offline). A 401 or 403 is an answer, and never a reason to try elsewhere.
 */
export function isGatewayFailure(status: number): boolean {
    return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One timed fetch. Combines the caller's own abort signal with the timeout. */
async function timedFetch(
    fetchImpl: FetchLike,
    url: string,
    init: RequestInit,
    timeoutMs: number
): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(url, { ...init, signal });
}

/**
 * Learn the instance over its trusted address. Null when it does not describe
 * itself (an older Polaris) - the client then simply has no alternates.
 */
export async function learnInstance(
    primary: string,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<InstanceRecord | null> {
    try {
        const response = await timedFetch(
            fetchImpl,
            `${primary}${INSTANCE_PATH}`,
            { credentials: "omit", headers: { accept: "application/json" } },
            timeoutMs
        );
        if (!response.ok) return null;
        return readInstance(await response.json());
    } catch {
        return null;
    }
}

/** What challenging one alternate found. */
export type AlternateVerdict =
    | { readonly kind: "same" }
    | { readonly kind: "different" }
    | { readonly kind: "unreachable"; readonly certificate: boolean };

/**
 * Challenge an alternate. The request carries no credential and no cookie: until
 * this says "same", nothing of the client's goes to that address.
 */
export async function verifyAlternate(
    origin: string,
    record: InstanceRecord,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<AlternateVerdict> {
    const nonce = freshNonce();
    let response: Response;
    try {
        response = await timedFetch(
            fetchImpl,
            `${origin}${CHALLENGE_PATH}`,
            {
                method: "POST",
                credentials: "omit",
                headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify({ nonce })
            },
            timeoutMs
        );
    } catch (caught) {
        return { kind: "unreachable", certificate: isCertificateFailure(caught) };
    }
    if (isGatewayFailure(response.status)) return { kind: "unreachable", certificate: false };
    let body: unknown = null;
    try {
        body = await response.json();
    } catch {
        // Something that is not Polaris answered; it is not this one either way.
    }
    const answer = (body ?? {}) as Record<string, unknown>;
    if (!response.ok || answer["id"] !== record.id || answer["nonce"] !== nonce) {
        return { kind: "different" };
    }
    const signed = await verifyChallenge(record, origin, nonce, answer["signature"]);
    return signed ? { kind: "same" } : { kind: "different" };
}

/** Which address a client is on, for the screen that shows it. */
export interface FailoverStatus {
    /** The origin the last request went to. */
    readonly origin: string;
    /** Whether that is an alternate rather than the address the client was given. */
    readonly local: boolean;
    /** `USING_LOCAL_WORDS` while on an alternate, otherwise null. */
    readonly words: string | null;
    /** Alternates that answered as a different Polaris and were never sent the credential. */
    readonly refused: readonly string[];
    /** Alternates this client could not open because it does not trust their certificate. */
    readonly untrusted: readonly string[];
}

/** Why an address answers as another Polaris, in words. */
export function refusedWords(origin: string): string {
    let host = origin;
    try {
        host = new URL(origin).host;
    } catch {
        // Already not a URL; show it as it is.
    }
    return `${host} answers as a different Polaris, so your sign-in was not sent there.`;
}

/** Why a local address could not be used, in words, for a client that relies on the system's trust. */
export const UNTRUSTED_WORDS =
    "Your local network address uses Polaris's own certificate, which this device does not trust yet. Open Admin -> Domains and use Trust this device.";

export interface FailoverOptions {
    /** The address the client was given. Always tried first. */
    readonly primary: string;
    /** What was learned over it, or null when nothing was (no alternates then). */
    readonly instance: InstanceRecord | null;
    readonly fetch?: FetchLike;
    readonly now?: () => number;
    readonly holdMs?: number;
    readonly verifiedMs?: number;
    readonly timeoutMs?: number;
}

export interface Failover {
    /**
     * Send `path` (with its query) to the address that answers. The init - and the
     * credential in its headers - goes to an alternate only after that alternate
     * proved it is the same instance. The body must be replayable (a string, a
     * Blob, FormData, URLSearchParams), since it may be sent twice.
     */
    request(path: string, init?: RequestInit): Promise<Response>;
    /** The origin to use right now, verifying an alternate first when the primary is down. */
    resolve(): Promise<string>;
    status(): FailoverStatus;
}

/**
 * The address-picking state for one client and one instance.
 *
 * Order on every request: the address it is holding (if the hold has not run
 * out), then the primary, then each verified alternate. A network failure or a
 * gateway status moves on to the next; any real answer - a 401 included - is
 * returned as it is. Once the hold runs out the primary is tried first again, so
 * the client goes back to it as soon as it answers.
 */
export function createFailover(options: FailoverOptions): Failover {
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    const now = options.now ?? Date.now;
    const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    const verifiedMs = options.verifiedMs ?? DEFAULT_VERIFIED_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const primary = readOrigin(options.primary) ?? options.primary.replace(/\/+$/, "");
    const instance = options.instance;
    const alternates = (instance?.addresses ?? []).filter((origin) => origin !== primary);

    let current = primary;
    let heldUntil = 0;
    const verifiedUntil = new Map<string, number>();
    const refused = new Set<string>();
    const untrusted = new Set<string>();

    async function verified(origin: string): Promise<boolean> {
        if ((verifiedUntil.get(origin) ?? 0) > now()) return true;
        if (!instance) return false;
        const verdict = await verifyAlternate(origin, instance, fetchImpl, timeoutMs);
        if (verdict.kind === "same") {
            verifiedUntil.set(origin, now() + verifiedMs);
            refused.delete(origin);
            untrusted.delete(origin);
            return true;
        }
        verifiedUntil.delete(origin);
        if (verdict.kind === "different") refused.add(origin);
        else if (verdict.certificate) untrusted.add(origin);
        return false;
    }

    function order(): string[] {
        const held = current !== primary && heldUntil > now() ? [current] : [];
        return [...new Set([...held, primary, ...alternates])];
    }

    function settle(origin: string): void {
        if (origin === primary) {
            current = primary;
            heldUntil = 0;
        } else if (origin !== current || heldUntil <= now()) {
            current = origin;
            heldUntil = now() + holdMs;
        }
    }

    async function request(path: string, init: RequestInit = {}): Promise<Response> {
        let firstFailure: unknown = null;
        let lastGateway: Response | null = null;
        for (const origin of order()) {
            if (origin !== primary && !(await verified(origin))) continue;
            try {
                const response = await timedFetch(fetchImpl, `${origin}${path}`, init, timeoutMs);
                if (isGatewayFailure(response.status)) {
                    lastGateway = response;
                    if (origin !== primary) verifiedUntil.delete(origin);
                    continue;
                }
                settle(origin);
                return response;
            } catch (caught) {
                if (init.signal?.aborted) throw caught;
                if (origin !== primary) verifiedUntil.delete(origin);
                firstFailure ??= caught;
            }
        }
        if (lastGateway) return lastGateway;
        throw firstFailure ?? new TypeError("fetch failed");
    }

    async function resolve(): Promise<string> {
        for (const origin of order()) {
            if (origin !== primary && !(await verified(origin))) continue;
            try {
                const response = await timedFetch(
                    fetchImpl,
                    `${origin}${INSTANCE_PATH}`,
                    { credentials: "omit" },
                    timeoutMs
                );
                if (isGatewayFailure(response.status)) continue;
                settle(origin);
                return origin;
            } catch {
                // Not answering; try the next one.
            }
        }
        return primary;
    }

    function status(): FailoverStatus {
        const local = current !== primary;
        return {
            origin: current,
            local,
            words: local ? USING_LOCAL_WORDS : null,
            refused: [...refused],
            untrusted: [...untrusted]
        };
    }

    return { request, resolve, status };
}
