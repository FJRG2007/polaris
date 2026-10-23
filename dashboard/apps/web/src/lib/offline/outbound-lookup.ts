/**
 * Name lookups that cannot take the whole server down when the internet does.
 *
 * Node resolves every name with `getaddrinfo` on libuv's thread pool, which has
 * four threads unless `UV_THREADPOOL_SIZE` says otherwise (Node docs, `dns.lookup`
 * "Implementation considerations"). With the line down, each lookup of an outside
 * name hangs for about ten seconds before `EAI_AGAIN`, a few pollers fill the
 * pool, and every other lookup - `localhost` included - plus file and crypto work
 * queues behind them. The dashboard then stalls on the LAN as well.
 *
 * So `dns.lookup` (which `net`, `tls`, `http` and the runtime's `fetch` all read at
 * call time) is wrapped, once, at startup:
 *
 * - Local names never touch the pool or the breaker: `localhost` is answered on
 *   the spot, and a name in `/etc/hosts` (`host.docker.internal`, the container's
 *   own name) from the file read at startup. Other local names - a single label
 *   such as a compose service, `.local`, `.lan`, `.internal`, `.home.arpa` - go to
 *   the system resolver as before, untouched by anything below.
 * - Outside names go through a breaker. A temporary failure (`EAI_AGAIN`, a
 *   timeout) opens it, and while it is open every outside lookup fails at once with
 *   the same `EAI_AGAIN` a real one would - no caller has to learn a new error. A
 *   probe every so often, by the next caller or by the timer below, closes it.
 * - Answers are cached briefly (30 s), a name that does not exist for less (5 s),
 *   and the same name asked twice while the first lookup is out is one lookup. The
 *   approach of `cacheable-lookup` and undici's `dns` interceptor, here because the
 *   runtime's `fetch` cannot take an interceptor from the `undici` package.
 *
 * State lives on `globalThis`, because Next bundles the instrumentation hook and
 * the routes that read `internetOffline()` separately.
 */

import dns from "node:dns";
import { isIP } from "node:net";
import { Breaker } from "./breaker";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

type Address = { address: string; family: number };
type Options = { family?: number | string; all?: boolean; hints?: number; order?: string; verbatim?: boolean };
type Callback = (error: NodeJS.ErrnoException | null, address?: string | Address[], family?: number) => void;
export type LookupFunction = (hostname: string, options: unknown, callback?: unknown) => void;
type Resolve = (hostname: string, options: Options & { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: Address[]) => void) => void;

export const POSITIVE_TTL_MS = 30_000;
export const NEGATIVE_TTL_MS = 5_000;
const CACHE_LIMIT = 512;
/** A name the dashboard already reaches, asked by the timer while offline. */
export const PROBE_NAME = "api.github.com";
const PROBE_EVERY_MS = 15_000;
/** Connect timeouts to outside addresses, in a row, that mean the line is down. */
const CONNECT_FAILURES_TO_OPEN = 3;

const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa", ".localdomain"];
/** Failures that say the network is down, not that the name is wrong. */
const OFFLINE_CODES = new Set(["EAI_AGAIN", "EAI_FAIL", "ETIMEOUT"]);

/** A name that is not on the internet: never gated, never a sign of being offline. */
export function isLocalName(hostname: string): boolean {
    const name = hostname.toLowerCase().replace(/\.$/, "");
    if (isIP(name) || name === "localhost" || !name.includes(".")) return true;
    return LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** `/etc/hosts`, read into name -> addresses. Missing or unreadable is empty. */
export function parseHosts(text: string): Map<string, Address[]> {
    const hosts = new Map<string, Address[]>();
    for (const raw of text.split("\n")) {
        const [address, ...names] = raw.replace(/#.*/, "").trim().split(/\s+/);
        const family = address ? isIP(address) : 0;
        if (!family) continue;
        for (const name of names) {
            const key = name.toLowerCase();
            hosts.set(key, [...(hosts.get(key) ?? []), { address: address!, family }]);
        }
    }
    return hosts;
}

function readHosts(): Map<string, Address[]> {
    try {
        return parseHosts(readFileSync("/etc/hosts", "utf8"));
    } catch {
        return new Map();
    }
}

function lookupError(hostname: string, code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException & { hostname?: string } = new Error(`getaddrinfo ${code} ${hostname}`);
    error.code = code;
    error.errno = undefined;
    error.syscall = "getaddrinfo";
    error.hostname = hostname;
    return error;
}

function wantedFamily(family: Options["family"]): 0 | 4 | 6 {
    if (family === 4 || family === "IPv4") return 4;
    if (family === 6 || family === "IPv6") return 6;
    return 0;
}

/** Answer in the shape the caller asked for: every address, or the first one. */
function reply(callback: Callback, options: Options, addresses: Address[], hostname: string): void {
    const family = wantedFamily(options.family);
    const fitting = family ? addresses.filter((entry) => entry.family === family) : addresses;
    process.nextTick(() => {
        if (fitting.length === 0) return callback(lookupError(hostname, "ENOTFOUND"));
        if (options.all) return callback(null, fitting);
        callback(null, fitting[0]!.address, fitting[0]!.family);
    });
}

export interface OutboundLookup {
    lookup: LookupFunction;
    breaker: Breaker;
}

export function createOutboundLookup(input: {
    resolve: Resolve;
    hosts?: Map<string, Address[]>;
    breaker?: Breaker;
    now?: () => number;
}): OutboundLookup {
    const now = input.now ?? Date.now;
    const hosts = input.hosts ?? new Map();
    const breaker = input.breaker ?? new Breaker({ now, threshold: CONNECT_FAILURES_TO_OPEN });
    const cache = new Map<string, { addresses: Address[] | null; until: number }>();
    const inflight = new Map<string, Callback[]>();

    function remember(key: string, addresses: Address[] | null): void {
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(key, { addresses, until: now() + (addresses ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    }

    function lookup(hostname: string, rawOptions: unknown, rawCallback?: unknown): void {
        const callback = (typeof rawOptions === "function" ? rawOptions : rawCallback) as Callback;
        const options: Options =
            typeof rawOptions === "number"
                ? { family: rawOptions }
                : typeof rawOptions === "object" && rawOptions !== null
                  ? (rawOptions as Options)
                  : {};
        const name = String(hostname ?? "").toLowerCase();

        if (name === "localhost" || name.endsWith(".localhost")) {
            return reply(callback, options, [
                { address: "127.0.0.1", family: 4 },
                { address: "::1", family: 6 }
            ], hostname);
        }
        const listed = hosts.get(name);
        if (listed) return reply(callback, options, listed, hostname);
        if (isLocalName(name)) return input.resolve(hostname, { ...options, all: true }, (error, addresses) =>
            error ? callback(error) : reply(callback, options, addresses, hostname)
        );

        const admission = breaker.admit();
        if (admission === "refuse") {
            return process.nextTick(() => callback(lookupError(hostname, "EAI_AGAIN")));
        }
        const key = `${name}|${options.family ?? 0}|${options.hints ?? 0}|${options.order ?? options.verbatim ?? ""}`;
        const hit = cache.get(key);
        // The probe asks the resolver itself: a cached answer proves nothing.
        if (admission === "pass" && hit && hit.until > now()) {
            if (hit.addresses) return reply(callback, options, hit.addresses, hostname);
            return process.nextTick(() => callback(lookupError(hostname, "ENOTFOUND")));
        }

        const waiting = inflight.get(key);
        const answer: Callback = (error, addresses) =>
            error ? callback(error) : reply(callback, options, addresses as Address[], hostname);
        if (waiting) return void waiting.push(answer);
        inflight.set(key, [answer]);
        input.resolve(hostname, { ...options, all: true }, (error, addresses) => {
            const callers = inflight.get(key) ?? [];
            inflight.delete(key);
            if (error) {
                const missing = error.code === "ENOTFOUND" || error.code === "ENODATA";
                // A name that does not exist is the resolver answering - unless it
                // is the probe's, which always exists.
                if (OFFLINE_CODES.has(error.code ?? "") || (missing && name === PROBE_NAME)) {
                    breaker.fail(Number.POSITIVE_INFINITY);
                } else if (missing) {
                    breaker.succeed();
                    remember(key, null);
                } else if (admission === "probe") breaker.fail();
            } else {
                breaker.succeed();
                remember(key, addresses);
            }
            for (const caller of callers) caller(error, addresses);
        });
    }

    // `util.promisify(dns.lookup)` answers `{ address, family }` through this; a
    // replacement without it would resolve to the bare address.
    Object.defineProperty(lookup, promisify.custom, {
        value: (hostname: string, options?: unknown) =>
            new Promise((resolve, reject) =>
                lookup(hostname, options ?? {}, (error: NodeJS.ErrnoException | null, address?: unknown, family?: number) =>
                    error
                        ? reject(error)
                        : resolve((options as Options | undefined)?.all ? address : { address, family })
                )
            )
    });
    return { lookup: lookup as LookupFunction, breaker };
}

interface Installed extends OutboundLookup {
    original: typeof dns.lookup;
    timer: NodeJS.Timeout;
}

const INSTALLED = Symbol.for("polaris.offline.lookup");
type Holder = { [INSTALLED]?: Installed };

/**
 * Put the wrapped lookup in place of `dns.lookup`, once per process. The breaker
 * says when it opens and when it closes - one line each, never one per call - and
 * a timer probes while it is open, so it closes even when nothing else asks.
 */
export function installOutboundLookup(): void {
    const holder = globalThis as Holder;
    if (holder[INSTALLED]) return;
    const original = dns.lookup;
    const breaker = new Breaker({
        threshold: CONNECT_FAILURES_TO_OPEN,
        onChange: (open) =>
            console.warn(
                open
                    ? "polaris: no internet connection - outside requests fail fast until it is back"
                    : "polaris: internet connection is back"
            )
    });
    const made = createOutboundLookup({ resolve: original as unknown as Resolve, hosts: readHosts(), breaker });
    const timer = setInterval(() => {
        if (breaker.isOpen) made.lookup(PROBE_NAME, { all: true }, () => undefined);
    }, PROBE_EVERY_MS);
    timer.unref();
    (dns as { lookup: unknown }).lookup = made.lookup;
    holder[INSTALLED] = { ...made, original, timer };
}

/** Whether this server has found it cannot reach the internet right now. */
export function internetOffline(): boolean {
    return (globalThis as Holder)[INSTALLED]?.breaker.isOpen ?? false;
}

/**
 * Tell the breaker about a request that failed past the lookup - a connect that
 * timed out to an outside address. Three in a row open it; a lookup that fails
 * opens it alone, since it already waited out the resolver's own timeout.
 */
export function noteOutboundFailure(hostname: string, error: unknown): void {
    const installed = (globalThis as Holder)[INSTALLED];
    if (!installed || isLocalName(hostname)) return;
    const codes = new Set<string>();
    for (let cause: unknown = error, depth = 0; cause && depth < 4; depth++) {
        const code = (cause as { code?: unknown }).code;
        if (typeof code === "string") codes.add(code);
        cause = (cause as { cause?: unknown }).cause;
    }
    if (codes.has("UND_ERR_CONNECT_TIMEOUT") || codes.has("ETIMEDOUT") || codes.has("ENETUNREACH") || codes.has("EHOSTUNREACH")) {
        installed.breaker.fail(1);
    }
}

const WATCHED_FETCH = Symbol.for("polaris.offline.fetch");

function hostOf(input: unknown): string {
    try {
        if (typeof input === "string" || input instanceof URL) return new URL(input).hostname;
        if (input && typeof (input as Request).url === "string") return new URL((input as Request).url).hostname;
    } catch {
        // A relative or malformed address is the caller's own error to report.
    }
    return "";
}

/**
 * Wrap the global `fetch` so a connect that timed out to an outside address is
 * counted too: a lookup answered from the cache, then a line that does not carry
 * the connection. The request itself is untouched, and so is its error.
 */
export function watchOutboundFetch(): void {
    const holder = globalThis as { [WATCHED_FETCH]?: true };
    if (holder[WATCHED_FETCH]) return;
    holder[WATCHED_FETCH] = true;
    const original = globalThis.fetch;
    const watched = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        try {
            return await original(input, init);
        } catch (error) {
            noteOutboundFailure(hostOf(input), error);
            throw error;
        }
    }) as typeof fetch;
    // Keep whatever marks the runtime or the framework left on it.
    Object.assign(watched, original);
    globalThis.fetch = watched;
}
