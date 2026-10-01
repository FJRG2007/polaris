/**
 * The HTTP every calendar client here shares.
 *
 * Every request leaves through an injected `Fetcher`, never the global `fetch`:
 * the dashboard hands in one that refuses private addresses, so a CalDAV URL or
 * a redirect typed by a user cannot reach into the host's own network. Redirects
 * are followed here, by hand, for the same reason - each hop goes back through
 * the fetcher, a hop may not downgrade https to http, and credentials only
 * travel to the origin they were given for (or a host under it).
 */

import { SyncAuthError, SyncConflictError, SyncGoneError, SyncNotFoundError, SyncRefusedError, SyncUnreachableError, safeReason } from "./errors";

/** How a client reaches the network. The dashboard injects an SSRF-guarded one. */
export type Fetcher = (url: string, init: RequestInit & { timeoutMs?: number }) => Promise<Response>;

/** Past this a server is treated as unreachable rather than slow. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** How many redirects one request may follow. */
export const MAX_REDIRECTS = 5;

export interface SendOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    /** Headers that carry credentials, dropped when a redirect leaves the host. */
    credentialHeaders?: readonly string[];
    /** The address the credentials were given for; the request's own when absent. */
    credentialOrigin?: URL;
}

/**
 * Hosts a configured one hands an account on to. iCloud answers on
 * `caldav.icloud.com` and keeps each account on `pNN-caldav.icloud.com`, which
 * needs the same password.
 */
const PARTITIONS: readonly { host: string; partition: RegExp }[] = [{ host: "caldav.icloud.com", partition: /^p\d+-caldav\.icloud\.com$/ }];

/**
 * Whether credentials given for `from` may be sent to `to`.
 *
 * The same origin, a host under it over https, or a partition the configured
 * host is known to move accounts to. A sibling host is not enough: without the
 * public suffix list, `example.co.uk` and `another.co.uk` look like siblings.
 */
export function sameSite(from: URL, to: URL): boolean {
    if (from.origin === to.origin) return true;
    if (to.protocol !== "https:" || to.port !== from.port) return false;
    if (to.hostname.endsWith(`.${from.hostname}`)) return true;
    return PARTITIONS.some((entry) => entry.host === from.hostname && entry.partition.test(to.hostname));
}

/** Parses Retry-After (seconds or an HTTP date) into seconds, or null. */
export function retryAfter(response: Response): number | null {
    const value = response.headers.get("retry-after");
    if (!value) return null;
    if (/^\d+$/.test(value.trim())) return Number(value.trim());
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

/** Only http(s) is spoken; anything else is refused before it reaches the fetcher. */
export function requireHttpUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new SyncRefusedError("Not a valid address", null);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SyncRefusedError("Only http and https addresses are supported", null);
    return url;
}

/** The address with any user or password in it removed, for messages. */
export function redactUrl(url: URL): string {
    return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * Sends one request, following redirects by hand.
 *
 * Returns the final response whatever its status; a network failure or a
 * timeout becomes `SyncUnreachableError`. Redirects keep the method and body
 * (a WebDAV PROPFIND or REPORT is only meaningful as itself) except 303, which
 * turns into a GET as HTTP says.
 */
export async function send(fetcher: Fetcher, rawUrl: string, options: SendOptions = {}): Promise<{ response: Response; url: URL }> {
    let url = requireHttpUrl(rawUrl);
    let method = options.method ?? "GET";
    let body = options.body;
    let headers = { ...options.headers };
    const origin = options.credentialOrigin ?? url;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (let hop = 0; ; hop++) {
        let response: Response;
        try {
            response = await fetcher(url.href, {
                method,
                headers,
                body,
                redirect: "manual",
                timeoutMs,
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            if (error instanceof SyncRefusedError || error instanceof SyncAuthError) throw error;
            if (error instanceof Error && error.name === "RefusedAddressError") throw error;
            const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
            throw new SyncUnreachableError(timedOut ? `No answer from ${url.host} in time` : `Could not reach ${url.host}`, null);
        }
        if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
        const location = response.headers.get("location");
        if (!location) return { response, url };
        await response.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new SyncUnreachableError(`Too many redirects from ${url.host}`, response.status);
        let next: URL;
        try {
            next = new URL(location, url);
        } catch {
            throw new SyncRefusedError("The server redirected to an invalid address", response.status);
        }
        if (next.protocol !== "https:" && next.protocol !== "http:") throw new SyncRefusedError("The server redirected to an unsupported address", response.status);
        if (url.protocol === "https:" && next.protocol === "http:") throw new SyncRefusedError("The server redirected from https to http", response.status);
        if (!sameSite(origin, next)) {
            const drop = new Set((options.credentialHeaders ?? ["authorization"]).map((h) => h.toLowerCase()));
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !drop.has(name.toLowerCase())));
        }
        if (response.status === 303) {
            method = "GET";
            body = undefined;
        }
        url = next;
    }
}

/**
 * Reads a body as text, refusing past `maxBytes`.
 *
 * Streams and stops reading the moment the cap is crossed, so a feed of a
 * gigabyte costs the cap, not the gigabyte.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new SyncRefusedError("The response is larger than allowed", response.status);
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new SyncRefusedError("The response is larger than allowed", response.status);
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof SyncRefusedError) throw error;
        throw new SyncUnreachableError("The connection dropped while reading", response.status);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8").decode(all);
}

/** Any JSON or XML answer a client reads is at most this long. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * The sync error for a failed response.
 *
 * `reason` is the server's own short explanation when the caller extracted one;
 * it is cut to a safe length by the error itself.
 */
export function errorFor(response: Response, reason = ""): Error {
    const status = response.status;
    const said = reason ? `: ${reason}` : "";
    if (status === 401 || status === 403) return new SyncAuthError(`The server refused the credentials (${status})${said}`, status);
    if (status === 404) return new SyncNotFoundError(`Not found on the server${said}`, status);
    if (status === 410) return new SyncGoneError(`The server discarded the sync state${said}`, status);
    if (status === 412) return new SyncConflictError(status);
    if (status === 429 || status >= 500) return new SyncUnreachableError(`The server is unavailable (${status})${said}`, status, retryAfter(response));
    return new SyncRefusedError(`The server refused the request (${status})${said}`, status);
}

/** A short, safe excerpt of a failed response's body, for an error message. */
export async function reasonOf(response: Response): Promise<string> {
    try {
        const text = await readCapped(response, 64 * 1024);
        return safeReason(text.replace(/<[^>]*>/g, " "));
    } catch {
        return "";
    }
}

/** `Basic` credentials, UTF-8 encoded as RFC 7617 recommends. */
export function basicAuth(username: string, password: string): string {
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
}

/** Hex SHA-256 of a string, through WebCrypto. */
export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads a successful JSON body and hands it to a validator.
 *
 * Every provider validates with zod before it reads a field; this keeps the
 * cap and the "not JSON" case in one place.
 */
export async function readJson(response: Response): Promise<unknown> {
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    if (text.trim() === "") return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new SyncUnreachableError("The server answered with something that is not JSON", response.status);
    }
}
