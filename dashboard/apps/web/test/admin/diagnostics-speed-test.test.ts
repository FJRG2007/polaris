/**
 * The speed test spends the server's own bandwidth, so it is bounded: a fixed
 * download it stops reading at, a fixed upload, a deadline per leg, one run at
 * a time, and a rate limit for the whole deployment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rateLimit = vi.fn(async (): Promise<{ ok: boolean; retryAfterMs: number }> => ({ ok: true, retryAfterMs: 0 }));
const setSetting = vi.fn(async () => undefined);

vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null), setSetting }));

const speed = await import("@/lib/diagnostics/speed-test");
const { runSpeedTest, mbps, DOWNLOAD_BYTES, UPLOAD_BYTES, LEG_TIMEOUT_MS, SPEED_TEST_LIMIT, SPEED_TEST_WINDOW_MS } = speed;

const CHUNK = 1_000_000;

interface Seen {
    pulled: number;
    uploadBytes: number | null;
    signals: Array<AbortSignal | null | undefined>;
}

/** A far end that sends far more than asked, and that errors its body on abort. */
function endpoint(seen: Seen, options: { stall?: boolean } = {}) {
    return vi.fn(async (url: string, init: RequestInit = {}) => {
        seen.signals.push(init.signal);
        if (url.includes("__up")) {
            seen.uploadBytes = (init.body as Uint8Array).byteLength;
            return new Response("ok");
        }
        if (url.includes("bytes=0")) return new Response(null, { headers: { date: new Date().toUTCString() } });
        let body: ReadableStreamDefaultController<Uint8Array> | null = null;
        init.signal?.addEventListener("abort", () => body?.error(new Error("aborted")));
        return new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    body = controller;
                },
                pull(controller) {
                    if (options.stall) return new Promise(() => undefined);
                    // Three times what was asked for, then the end: enough to
                    // see an overrun, finite so a regression fails, not hangs.
                    if (seen.pulled >= 3 * DOWNLOAD_BYTES) return controller.close();
                    seen.pulled += CHUNK;
                    controller.enqueue(new Uint8Array(CHUNK));
                }
            })
        );
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("the speed test", () => {
    it("stops reading the download at its size, uploads exactly its size, and bounds every leg", async () => {
        const seen: Seen = { pulled: 0, uploadBytes: null, signals: [] };
        vi.stubGlobal("fetch", endpoint(seen));
        const outcome = await runSpeedTest();
        expect(outcome.ok).toBe(true);
        // The far end sends three times as much; reading stopped at the size, give or take
        // what the stream had already buffered ahead.
        expect(seen.pulled).toBeGreaterThanOrEqual(DOWNLOAD_BYTES);
        expect(seen.pulled).toBeLessThanOrEqual(DOWNLOAD_BYTES + 2 * CHUNK);
        expect(seen.uploadBytes).toBe(UPLOAD_BYTES);
        expect(seen.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
        expect(setSetting).toHaveBeenCalledWith("diagnostics.speedTest", expect.any(String));
    });

    it("measures what arrived before the deadline when the download stalls", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const seen: Seen = { pulled: 0, uploadBytes: null, signals: [] };
        vi.stubGlobal("fetch", endpoint(seen, { stall: true }));
        const pending = runSpeedTest();
        await vi.advanceTimersByTimeAsync(LEG_TIMEOUT_MS + 10);
        const outcome = await pending;
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.result.downloadMbps).toBeNull();
        expect(seen.uploadBytes).toBe(UPLOAD_BYTES);
    });

    it("runs one test at a time, even for two requests landing together", async () => {
        const seen: Seen = { pulled: 0, uploadBytes: null, signals: [] };
        vi.stubGlobal("fetch", endpoint(seen));
        const [first, second] = await Promise.all([runSpeedTest(), runSpeedTest()]);
        expect(first.ok).toBe(true);
        expect(second).toMatchObject({ ok: false, reason: "busy" });
        expect(rateLimit).toHaveBeenCalledTimes(1);
    });

    it("is rate limited for the whole deployment, and spends nothing when refused", async () => {
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        rateLimit.mockResolvedValueOnce({ ok: false, retryAfterMs: 120_000 });
        expect(await runSpeedTest()).toEqual({ ok: false, reason: "limited", retryAfterMs: 120_000 });
        expect(rateLimit).toHaveBeenCalledWith("diagnostics:speed-test", SPEED_TEST_LIMIT, SPEED_TEST_WINDOW_MS);
        expect(fetcher).not.toHaveBeenCalled();
        // The refusal released the lock: the next one is asked again.
        const seen: Seen = { pulled: 0, uploadBytes: null, signals: [] };
        vi.stubGlobal("fetch", endpoint(seen));
        expect((await runSpeedTest()).ok).toBe(true);
    });

    it("keeps its limits small", () => {
        expect(DOWNLOAD_BYTES + UPLOAD_BYTES).toBeLessThanOrEqual(16_000_000);
        expect(LEG_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
        expect(SPEED_TEST_LIMIT).toBeLessThanOrEqual(5);
    });

    it("converts to megabits per second, and nothing measured is null", () => {
        expect(mbps(1_250_000, 1000)).toBe(10);
        expect(mbps(0, 1000)).toBeNull();
        expect(mbps(1000, 0)).toBeNull();
    });
});
