/**
 * Parse HTTP access logs out of a container's raw stdout. Deploy apps expose their
 * client-facing traffic in one of two shapes: the Common/Combined Log Format that
 * nginx, Apache, and most web servers emit, or one JSON object per line (Traefik
 * and many frameworks). This reads both from the same stream and yields typed
 * request entries; lines that are not access logs (startup notices, stack traces)
 * are dropped, so an app that does not log HTTP access simply yields none. Pure:
 * given the log text, produce the entries.
 */

export interface HttpLogEntry {
    /** ISO-8601 request time when derivable, else null. */
    readonly time: string | null;
    /** Client IP - real when the app is reached directly, the proxy's otherwise. */
    readonly ip: string;
    readonly method: string;
    readonly path: string;
    readonly status: number;
    /** Requested host/authority when the format carries it, else null. */
    readonly host: string | null;
    /** Response size in bytes when present, else null. */
    readonly bytes: number | null;
    readonly referer: string | null;
    readonly userAgent: string | null;
    /** Upstream latency in milliseconds when present, else null. */
    readonly durationMs: number | null;
}

/** One time bucket of HTTP traffic, derived from access-log entries. */
export interface HttpMetricPoint {
    /** Bucket start (epoch ms). */
    readonly t: number;
    /** Requests in the bucket. */
    readonly requests: number;
    /** Percent of requests that returned 5xx, or null when the bucket is empty. */
    readonly errorRate: number | null;
    /** Mean response time (ms) over entries that carry a duration, else null. */
    readonly avgResponseMs: number | null;
    /** Response throughput (bytes/second) across the bucket. */
    readonly bytesPerSec: number;
}

/**
 * Bucket access-log entries into an evenly spaced time series over [from, to):
 * request volume, 5xx error rate, mean response time, and egress throughput.
 * Entries outside the window or without a parseable time are ignored. Pure.
 */
export function bucketHttpMetrics(
    entries: readonly HttpLogEntry[],
    from: number,
    to: number,
    buckets = 60
): HttpMetricPoint[] {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    const count = Math.max(1, Math.min(Math.floor(buckets), 500));
    const width = (to - from) / count;
    const slots = Array.from({ length: count }, (_, index) => ({
        t: Math.round(from + index * width),
        requests: 0,
        errors: 0,
        durSum: 0,
        durCount: 0,
        bytes: 0
    }));
    for (const entry of entries) {
        if (!entry.time) continue;
        const ms = Date.parse(entry.time);
        if (!Number.isFinite(ms) || ms < from || ms >= to) continue;
        const slot = slots[Math.min(count - 1, Math.floor((ms - from) / width))]!;
        slot.requests += 1;
        if (entry.status >= 500) slot.errors += 1;
        if (entry.durationMs !== null) {
            slot.durSum += entry.durationMs;
            slot.durCount += 1;
        }
        if (entry.bytes !== null) slot.bytes += entry.bytes;
    }
    const seconds = width / 1000;
    return slots.map((slot) => ({
        t: slot.t,
        requests: slot.requests,
        errorRate: slot.requests > 0 ? (slot.errors / slot.requests) * 100 : null,
        avgResponseMs: slot.durCount > 0 ? slot.durSum / slot.durCount : null,
        bytesPerSec: seconds > 0 ? slot.bytes / seconds : 0
    }));
}

// Docker prepends an RFC-3339 timestamp when logs are read with --timestamps (the
// SSH port does; the local daemon may not), so strip and reuse it as a fallback.
const DOCKER_TS = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2}))\s+/;
// Common/Combined Log Format: ip - - [date] "METHOD path proto" status bytes ["ref" "ua"].
const CLF =
    /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)\s+([^"]*)"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)")?/;
const CLF_DATE = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/;
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** Extract every access-log entry from raw container output, in stream order. */
export function parseHttpLogs(raw: string): HttpLogEntry[] {
    if (!raw) return [];
    const entries: HttpLogEntry[] = [];
    for (const line of raw.split("\n")) {
        const stamp = DOCKER_TS.exec(line);
        const rest = (stamp ? line.slice(stamp[0].length) : line).trim();
        if (!rest) continue;
        let entry = rest.startsWith("{") && rest.endsWith("}") ? fromJson(rest) : fromClf(rest);
        if (!entry) continue;
        if (!entry.time && stamp) entry = { ...entry, time: toIso(stamp[1]!) };
        entries.push(entry);
    }
    return entries;
}

function fromClf(line: string): HttpLogEntry | null {
    const match = CLF.exec(line);
    if (!match) return null;
    return {
        time: clfDateToIso(match[2]!),
        ip: match[1] === "-" ? "-" : match[1]!,
        method: match[3]!,
        path: match[4]!,
        status: Number(match[6]),
        host: null,
        bytes: match[7] === "-" ? null : Number(match[7]),
        referer: clean(match[8]),
        userAgent: clean(match[9]),
        durationMs: null
    };
}

function fromJson(line: string): HttpLogEntry | null {
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return null;
    }
    const method = str(pick(obj, ["RequestMethod", "method", "request_method", "req_method", "verb"]));
    const path = str(pick(obj, ["RequestPath", "path", "uri", "request_uri", "url", "request"]));
    const status = num(pick(obj, ["OriginStatus", "DownstreamStatus", "status", "status_code", "statusCode"]));
    // Without a method, path, and status the line is not an HTTP access record.
    if (!method || !path || status === null) return null;
    const ip =
        str(pick(obj, ["ClientHost", "ClientAddr", "remote_addr", "client_ip", "clientIp", "ip", "remoteIp"])) ?? "-";
    const durationNs = num(pick(obj, ["Duration"]));
    return {
        time: toIso(str(pick(obj, ["StartUTC", "time", "timestamp", "ts", "time_local", "@timestamp"]))),
        ip: stripPort(ip),
        method,
        path,
        status,
        host: str(pick(obj, ["RequestHost", "host", "http_host", "authority"])),
        bytes: num(pick(obj, ["DownstreamContentSize", "bytes", "body_bytes_sent", "bytes_sent", "size"])),
        referer: clean(str(pick(obj, ["request_Referer", "http_referer", "referer", "referrer"]))),
        userAgent: clean(str(pick(obj, ["request_User-Agent", "request_User_Agent", "http_user_agent", "user_agent", "userAgent"]))),
        // Traefik reports Duration in nanoseconds; other JSON logs vary, so also read explicit ms.
        durationMs: durationNs !== null ? durationNs / 1e6 : num(pick(obj, ["duration_ms", "responseTime", "response_time_ms"]))
    };
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return undefined;
}

function str(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return null;
}

function num(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return null;
}

/** Normalize placeholder log tokens ("-", "") to null. */
function clean(value: string | null | undefined): string | null {
    return value && value !== "-" ? value : null;
}

/** Drop the port off an "ip:port" client address so the column shows just the IP. */
function stripPort(value: string): string {
    const match = IPV4_WITH_PORT.exec(value);
    return match ? match[1]! : value;
}

function toIso(value: string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Convert a CLF date ("21/Jul/2026:12:32:05 +0000") to ISO-8601. */
function clfDateToIso(value: string): string | null {
    const match = CLF_DATE.exec(value);
    if (!match) return null;
    const month = MONTHS.indexOf(match[2]!);
    if (month < 0) return null;
    const offset = `${match[7]!.slice(0, 3)}:${match[7]!.slice(3)}`;
    const date = new Date(`${match[3]}-${pad(month + 1)}-${match[1]}T${match[4]}:${match[5]}:${match[6]}${offset}`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}
