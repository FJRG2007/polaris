/**
 * How fast this server reaches the internet, measured on demand.
 *
 * From the server, not the browser: the question an operator is asking is
 * whether the box can pull images, serve downloads and hold calls, and the
 * reader's own connection says nothing about that. It runs in this process
 * against a public speed endpoint - a bounded download and a bounded upload -
 * so there is no resident process, no new image and nothing to install.
 *
 * Bounded three ways: a fixed transfer size, a deadline per leg (whatever moved
 * before the deadline is what is measured), and a rate limit, because every run
 * spends the server's own bandwidth.
 *
 * Server-only.
 */

import { z } from "zod";
import { randomBytes } from "node:crypto";
import { TIME_REFERENCE_URL } from "./checks";
import { rateLimit } from "@/lib/rate-limit-service";
import { getSetting, setSetting } from "@/lib/setting-store";

const DOWNLOAD_BYTES = 10_000_000;
const UPLOAD_BYTES = 2_000_000;
const DOWNLOAD_URL = `https://speed.cloudflare.com/__down?bytes=${DOWNLOAD_BYTES}`;
const UPLOAD_URL = "https://speed.cloudflare.com/__up";
const LEG_TIMEOUT_MS = 20_000;
const LATENCY_SAMPLES = 3;
/** Runs per window, for the whole deployment: it is one server's bandwidth. */
export const SPEED_TEST_LIMIT = 3;
export const SPEED_TEST_WINDOW_MS = 15 * 60 * 1000;
const RESULT_KEY = "diagnostics.speedTest";

export const speedResultSchema = z.object({
    downloadMbps: z.number().nullable(),
    uploadMbps: z.number().nullable(),
    latencyMs: z.number().nullable(),
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

async function latency(): Promise<number | null> {
    let best: number | null = null;
    for (let sample = 0; sample < LATENCY_SAMPLES; sample++) {
        try {
            const started = performance.now();
            const response = await fetch(TIME_REFERENCE_URL, { cache: "no-store", signal: AbortSignal.timeout(5000) });
            const took = performance.now() - started;
            await response.body?.cancel().catch(() => undefined);
            if (response.ok) best = best === null ? took : Math.min(best, took);
        } catch {
            // One lost sample is not a result; the others still are.
        }
    }
    return best === null ? null : Math.round(best);
}

async function download(): Promise<number | null> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), LEG_TIMEOUT_MS);
    const started = performance.now();
    let bytes = 0;
    try {
        const response = await fetch(DOWNLOAD_URL, { cache: "no-store", signal: controller.signal });
        if (!response.ok || !response.body) return null;
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
        }
    } catch {
        // The deadline: what arrived before it is the measurement.
    } finally {
        clearTimeout(deadline);
    }
    return mbps(bytes, performance.now() - started);
}

async function upload(): Promise<number | null> {
    const body = randomBytes(UPLOAD_BYTES);
    const started = performance.now();
    try {
        const response = await fetch(UPLOAD_URL, {
            method: "POST",
            body,
            cache: "no-store",
            signal: AbortSignal.timeout(LEG_TIMEOUT_MS)
        });
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) return null;
    } catch {
        return null;
    }
    return mbps(UPLOAD_BYTES, performance.now() - started);
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
    const allowed = await rateLimit("diagnostics:speed-test", SPEED_TEST_LIMIT, SPEED_TEST_WINDOW_MS);
    if (!allowed.ok) return { ok: false, reason: "limited", retryAfterMs: allowed.retryAfterMs };
    running = true;
    try {
        // One leg at a time: run together they would share the link and each
        // measure half of it.
        const latencyMs = await latency();
        const downloadMbps = await download();
        const uploadMbps = await upload();
        const result: SpeedResult = { downloadMbps, uploadMbps, latencyMs, at: new Date().toISOString() };
        await setSetting(RESULT_KEY, JSON.stringify(result)).catch(() => undefined);
        return { ok: true, result };
    } finally {
        running = false;
    }
}
