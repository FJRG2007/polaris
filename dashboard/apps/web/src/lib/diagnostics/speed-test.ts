/**
 * How fast this server reaches the internet, measured on demand.
 *
 * From the server, not the browser: the question an operator is asking is
 * whether the box can pull images, serve downloads and hold calls, and the
 * reader's own connection says nothing about that. It runs in this process
 * against a public speed endpoint, so there is no resident process, no new
 * image and nothing to install.
 *
 * Measured the way the public speed tests measure, because the naive way is
 * wrong by a factor of three on a fast line. One connection moving 10 MB down and
 * 2 MB up, timed from the request onwards, reported 307 and 37 Mbps on a gigabit
 * line that speedtest.net put at 865 and 944: at that rate 2 MB is 16 ms of
 * transfer, and the rest of what was timed was DNS, the TLS handshake, the round
 * trip and TCP still ramping up. On the same server, several connections and
 * enough data to reach full speed measured 805 to 854 down and 734 to 900 up.
 *
 * So each leg runs `STREAMS` connections at once, each asking for growing chunks
 * (`DOWNLOAD_CHUNKS`, `UPLOAD_CHUNKS`) so a slow line still finishes a small one,
 * and the rate is the bytes moved over the time they took: from the first byte
 * to the last for a download, and per connection from its first answer to its
 * last for an upload. The figures move with whatever else the line is carrying
 * at the time, as any speed test's do. Latency is the median of several empty
 * requests on a warm connection, less the time the far end says it spent: the
 * round trip, not the handshake.
 *
 * Bounded three ways: a cap on what each leg moves, a deadline per leg (whatever
 * moved before it is what is measured), and a rate limit, because every run
 * spends the server's own bandwidth.
 *
 * Server-only.
 */

import { z } from "zod";
import { randomBytes } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit-service";
import { getSetting, setSetting } from "@/lib/setting-store";

const ENDPOINT = "https://speed.cloudflare.com";
/** The most a leg moves: a gigabit line gets through these in about two seconds. */
export const DOWNLOAD_BYTES = 200_000_000;
export const UPLOAD_BYTES = 100_000_000;
/**
 * What each connection asks for in turn; the last size repeats. Downloads stop
 * at 5 MB because the endpoint answers 429 to 10 MB and up from an address that
 * has used it heavily, while 5 MB still goes through - and six connections of
 * 5 MB measured the same gigabit line as four of 25 MB did.
 */
export const DOWNLOAD_CHUNKS: readonly number[] = [1_000_000, 5_000_000];
export const UPLOAD_CHUNKS: readonly number[] = [1_000_000, 5_000_000, 10_000_000];
/** Connections per leg. One cannot fill a fast line across a long round trip;
 *  six of 5 MB measured 805 to 854 Mbps where speedtest.net read 865. */
export const STREAMS = 6;
export const LEG_TIMEOUT_MS = 10_000;
const LATENCY_SAMPLES = 8;
/** Runs per window, for the whole deployment: it is one server's bandwidth. */
export const SPEED_TEST_LIMIT = 3;
export const SPEED_TEST_WINDOW_MS = 15 * 60 * 1000;
const RESULT_KEY = "diagnostics.speedTest";

export const speedResultSchema = z.object({
    downloadMbps: z.number().nullable(),
    uploadMbps: z.number().nullable(),
    latencyMs: z.number().nullable(),
    /** Where the far end answered from, as an airport code (MAD). Absent on a
     *  result stored before it was recorded. */
    server: z.string().nullable().optional(),
    at: z.string()
});
export type SpeedResult = z.infer<typeof speedResultSchema>;

export type SpeedTestOutcome =
    | { readonly ok: true; readonly result: SpeedResult }
    | { readonly ok: false; readonly reason: "busy" | "limited"; readonly retryAfterMs: number };

let running = false;

/** Megabits per second, to one decimal. */
export function mbps(bytes: number, ms: number): number | null {
    if (!(ms > 0) || !(bytes > 0)) return null;
    return Math.round(((bytes * 8) / (ms / 1000) / 1_000_000) * 10) / 10;
}

/** The time the far end says it spent on a request, from its Server-Timing. */
function serverMs(response: Response): number {
    const spent = /dur=([\d.]+)/.exec(response.headers.get("server-timing") ?? "");
    return spent ? Number(spent[1]) : 0;
}

/** The data center that answered: the last part of Cloudflare's ray id. */
function colo(response: Response): string | null {
    const code = /-([A-Z]{3})$/.exec(response.headers.get("cf-ray") ?? "");
    return code?.[1] ?? null;
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
}

async function latency(): Promise<{ ms: number | null; server: string | null }> {
    const samples: number[] = [];
    let server: string | null = null;
    // One more than is kept: the first pays for DNS and the handshake, which is
    // not the round trip being asked about.
    for (let sample = 0; sample <= LATENCY_SAMPLES; sample++) {
        try {
            const started = performance.now();
            const response = await fetch(`${ENDPOINT}/__down?bytes=0`, {
                cache: "no-store",
                signal: AbortSignal.timeout(5000)
            });
            await response.arrayBuffer();
            const took = performance.now() - started - serverMs(response);
            server ??= colo(response);
            if (response.ok && sample > 0) samples.push(Math.max(0, took));
        } catch {
            // One lost sample is not a result; the others still are.
        }
    }
    const ms = median(samples);
    return { ms: ms === null ? null : Math.round(ms), server };
}

/** How one request went: moved, turned away for its size, or failed outright. */
type Transfer = "moved" | "refused" | "failed";

/** The endpoint's answer to a request it will not serve at that size. */
function refusal(response: Response): Transfer {
    return response.status === 429 || response.status === 413 ? "refused" : "failed";
}

/**
 * Run `STREAMS` copies of one connection's loop until the leg's cap, its
 * deadline, or a failure. Each connection steps up through `sizes` after every
 * request that moved, and a request refused for its size steps that connection
 * back down for good instead of ending it - the endpoint's limit on large
 * requests is not the line's speed.
 */
async function leg(
    cap: number,
    sizes: readonly number[],
    transfer: (size: number, signal: AbortSignal, stream: number) => Promise<Transfer>
): Promise<void> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), LEG_TIMEOUT_MS);
    let asked = 0;
    const stream = async (which: number): Promise<void> => {
        let level = 0;
        let ceiling = sizes.length - 1;
        while (!controller.signal.aborted) {
            const size = Math.min(sizes[level] ?? 0, cap - asked);
            if (size <= 0) return;
            asked += size;
            const outcome = await transfer(size, controller.signal, which);
            if (outcome === "moved") {
                level = Math.min(level + 1, ceiling);
                continue;
            }
            asked -= size;
            if (outcome === "failed" || level === 0) return;
            ceiling = level - 1;
            level = ceiling;
        }
    };
    try {
        // The deadline ends every connection; what moved before it is the measurement.
        await Promise.all(
            Array.from({ length: STREAMS }, (_, which) => stream(which).catch(() => undefined))
        );
    } finally {
        clearTimeout(deadline);
    }
}

/** Timed from the first byte to the last, across every connection. */
async function download(): Promise<number | null> {
    let bytes = 0;
    let first: number | null = null;
    let last = 0;
    await leg(DOWNLOAD_BYTES, DOWNLOAD_CHUNKS, async (size, signal) => {
        const response = await fetch(`${ENDPOINT}/__down?bytes=${size}`, {
            cache: "no-store",
            signal
        });
        if (!response.ok || !response.body) return refusal(response);
        const reader = response.body.getReader();
        let read = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            first ??= performance.now();
            last = performance.now();
            read += value.byteLength;
            bytes += value.byteLength;
            // A body that runs past what was asked for is not read on, whatever
            // the far end sends.
            if (read >= size) {
                await reader.cancel().catch(() => undefined);
                break;
            }
        }
        return "moved";
    });
    return first === null ? null : mbps(bytes, last - first);
}

/**
 * Each connection timed on its own, and their rates added up.
 *
 * An upload is only known to have arrived when it is answered, so a connection's
 * rate is what it sent after its first answer over the time since that answer:
 * before it lie the handshake and TCP's ramp, the overhead the download leaves
 * out by timing from its first byte. Per connection, because the connections
 * finish their first chunks together - one clock started at the first answer
 * anywhere would credit the others' whole first chunks to a few milliseconds.
 * A connection that only ever finished one chunk, on a slow line, is timed from
 * its request instead.
 */
async function upload(): Promise<number | null> {
    // One buffer, sliced: the payload is noise either way, and fresh randomness
    // for every chunk is memory and time nobody needs.
    const payload = randomBytes(Math.max(...UPLOAD_CHUNKS));
    const streams = Array.from({ length: STREAMS }, () => ({
        firstBytes: 0,
        firstTook: 0,
        firstAt: null as number | null,
        bytes: 0,
        last: 0
    }));
    await leg(UPLOAD_BYTES, UPLOAD_CHUNKS, async (size, signal, which) => {
        const started = performance.now();
        const response = await fetch(`${ENDPOINT}/__up`, {
            method: "POST",
            body: payload.subarray(0, size),
            cache: "no-store",
            signal
        });
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) return refusal(response);
        const now = performance.now();
        const own = streams[which];
        if (!own) return "failed";
        if (own.firstAt === null) {
            own.firstAt = now;
            own.firstBytes = size;
            own.firstTook = now - started;
        } else {
            own.bytes += size;
            own.last = now;
        }
        return "moved";
    });
    // Bytes per millisecond, added up across connections and rounded once.
    let rate = 0;
    for (const own of streams) {
        if (own.firstAt === null) continue;
        const [bytes, ms] =
            own.bytes > 0 ? [own.bytes, own.last - own.firstAt] : [own.firstBytes, own.firstTook];
        if (ms > 0) rate += bytes / ms;
    }
    return mbps(rate * 1000, 1000);
}

/** The last result, or null before the first run. */
export async function lastSpeedResult(): Promise<SpeedResult | null> {
    const raw = await getSetting(RESULT_KEY).catch(() => null);
    if (!raw) return null;
    try {
        const parsed = speedResultSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Run one test, unless one is running or the window is spent. */
export async function runSpeedTest(): Promise<SpeedTestOutcome> {
    if (running) return { ok: false, reason: "busy", retryAfterMs: LEG_TIMEOUT_MS };
    // Taken before the first await, so two clicks that land together cannot both
    // pass the check while the rate limit is being read.
    running = true;
    try {
        const allowed = await rateLimit(
            "diagnostics:speed-test",
            SPEED_TEST_LIMIT,
            SPEED_TEST_WINDOW_MS
        );
        if (!allowed.ok)
            return { ok: false, reason: "limited", retryAfterMs: allowed.retryAfterMs };
        // One leg at a time: run together they would share the link and each
        // measure half of it.
        const { ms: latencyMs, server } = await latency();
        const downloadMbps = await download();
        const uploadMbps = await upload();
        const result: SpeedResult = {
            downloadMbps,
            uploadMbps,
            latencyMs,
            server,
            at: new Date().toISOString()
        };
        await setSetting(RESULT_KEY, JSON.stringify(result)).catch(() => undefined);
        return { ok: true, result };
    } finally {
        running = false;
    }
}
