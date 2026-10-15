/**
 * What a check is, and whether one result of it counts as up.
 *
 * Pure: the network half (`lib/probe.ts`) gathers what it saw into a
 * `ProbeResult`, and the decision of up or down is made here, where it can be
 * tested without a socket.
 */

export const CHECK_KINDS = ["http", "tcp", "dns", "ping"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT"] as const;
export type DnsType = (typeof DNS_TYPES)[number];

/** The shortest interval a check may run at. A status page is not a load test. */
export const MIN_INTERVAL_SEC = 30;
export const MAX_INTERVAL_SEC = 3600;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 15_000;

/** What a check asks, as stored. */
export interface CheckSpec {
    readonly kind: CheckKind;
    readonly target: string;
    readonly port: number | null;
    readonly expectStatus: number | null;
    readonly keyword: string;
    readonly dnsType: DnsType | null;
    readonly dnsExpect: string;
    readonly timeoutMs: number;
}

/** What the network half saw. `error` is set when nothing usable came back. */
export type ProbeResult =
    | {
          readonly kind: "http";
          readonly status: number;
          readonly body: string;
          readonly latencyMs: number;
      }
    | { readonly kind: "tcp"; readonly latencyMs: number }
    | { readonly kind: "dns"; readonly answers: readonly string[]; readonly latencyMs: number }
    | { readonly kind: "error"; readonly error: CheckError; readonly latencyMs: number | null };

/** Why a check failed, as a code the screens translate. */
export type CheckError =
    | "timeout"
    | "refused"
    | "unresolved"
    | "blocked"
    | "tls"
    | "network"
    | "status"
    | "keyword"
    | "dnsMismatch"
    | "dnsEmpty";

export interface CheckOutcome {
    readonly ok: boolean;
    readonly latencyMs: number | null;
    readonly error: CheckError | null;
}

/** Whether an HTTP status is what the check expects: the exact one when it
 *  names one, any 2xx or 3xx otherwise. */
export function statusMatches(status: number, expected: number | null): boolean {
    if (expected !== null) return status === expected;
    return status >= 200 && status < 400;
}

/** Normalizes a DNS answer for comparison: case-insensitive, no trailing dot. */
export function normalizeDnsValue(value: string): string {
    return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Decides one run of a check from what the network half saw. */
export function evaluate(spec: CheckSpec, result: ProbeResult): CheckOutcome {
    if (result.kind === "error") {
        return { ok: false, latencyMs: result.latencyMs, error: result.error };
    }
    if (result.kind === "http") {
        if (!statusMatches(result.status, spec.expectStatus)) {
            return { ok: false, latencyMs: result.latencyMs, error: "status" };
        }
        if (spec.keyword && !result.body.includes(spec.keyword)) {
            return { ok: false, latencyMs: result.latencyMs, error: "keyword" };
        }
        return { ok: true, latencyMs: result.latencyMs, error: null };
    }
    if (result.kind === "dns") {
        if (result.answers.length === 0) {
            return { ok: false, latencyMs: result.latencyMs, error: "dnsEmpty" };
        }
        const wanted = normalizeDnsValue(spec.dnsExpect);
        if (wanted && !result.answers.some((answer) => normalizeDnsValue(answer) === wanted)) {
            return { ok: false, latencyMs: result.latencyMs, error: "dnsMismatch" };
        }
        return { ok: true, latencyMs: result.latencyMs, error: null };
    }
    return { ok: true, latencyMs: result.latencyMs, error: null };
}

/** The port a TCP or ping check dials when none is given. */
export function defaultPort(kind: CheckKind): number | null {
    return kind === "ping" ? 443 : null;
}

/** When a check runs next, from when it last ran, never sooner than the minimum. */
export function nextRunAt(from: Date, intervalSec: number): Date {
    const seconds = Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, intervalSec));
    return new Date(from.getTime() + seconds * 1000);
}

/** A timeout held inside the bounds the runner allows. */
export function clampTimeout(timeoutMs: number): number {
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)));
}

/**
 * Whether an address may be dialed by a check.
 *
 * Private ranges are allowed on purpose: a status page for a home server is
 * mostly about machines on the same network, and the person who types the
 * target is an administrator. What is refused is what is never a service the
 * operator runs and is the classic way to reach inside the host: loopback (the
 * dashboard's own container), link-local (the cloud metadata address lives
 * there), the unspecified address and multicast.
 */
export function addressAllowed(address: string): boolean {
    const value = address.trim().toLowerCase();
    if (value.includes(":")) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
        if (mapped) return addressAllowed(mapped[1]!);
        if (value === "::" || value === "::1") return false;
        if (/^fe[89ab][0-9a-f]:/.test(value)) return false;
        if (value.startsWith("ff")) return false;
        return true;
    }
    const parts = value.split(".").map((part) => Number(part));
    if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
        return false;
    }
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a >= 224) return false;
    return true;
}
