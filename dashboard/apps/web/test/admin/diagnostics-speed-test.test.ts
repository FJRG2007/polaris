/**
 * The speed test spends the server's own bandwidth, so it is bounded: a cap on
 * what each leg moves, a deadline per leg, one run at a time, and a rate limit
 * for the whole deployment. Within those bounds it has to measure the line, not
 * the handshake: several connections at once, growing chunks, and a rate taken
 * over the time the bytes actually moved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rateLimit = vi.fn(
    async (): Promise<{ ok: boolean; retryAfterMs: number }> => ({ ok: true, retryAfterMs: 0 })
);
const setSetting = vi.fn(async () => undefined);

vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null), setSetting }));

const speed = await import("@/lib/diagnostics/speed-test");
const {
    runSpeedTest,
    mbps,
    speedResultSchema,
    DOWNLOAD_BYTES,
    UPLOAD_BYTES,
    DOWNLOAD_CHUNKS,
    UPLOAD_CHUNKS,
    STREAMS,
    LEG_TIMEOUT_MS,
    SPEED_TEST_LIMIT,
    SPEED_TEST_WINDOW_MS
} = speed;

const PIECE = 1_000_000;

interface Seen {
    /** Bytes the far end handed over on download bodies. */
    pulled: number;
    /** The size each download asked for, in order. */
    asked: number[];
    /** The size of each upload body, in order. */
    uploaded: number[];
    /** The most downloads open at once. */
    widest: number;
    signals: Array<AbortSignal | null | undefined>;
}

function seen(): Seen {
    return { pulled: 0, asked: [], uploaded: [], widest: 0, signals: [] };
}

/**
 * A far end that sends three times what was asked for (so an overrun shows), a
 * cf-ray naming its data center, and a body that errors on abort.
 */
function endpoint(record: Seen, options: { stall?: boolean; refuseAbove?: number } = {}) {
    let open = 0;
    return vi.fn(async (url: string, init: RequestInit = {}) => {
        record.signals.push(init.signal);
        if (url.includes("__up")) {
            if ((init.body as Uint8Array).byteLength > (options.refuseAbove ?? Infinity))
                return new Response("Too Many Requests", { status: 429 });
            record.uploaded.push((init.body as Uint8Array).byteLength);
            return new Response("ok");
        }
        const size = Number(new URL(url).searchParams.get("bytes"));
        if (size === 0)
            return new Response(null, {
                headers: { "cf-ray": "8f1a2b3c4d5e6f70-MAD", "server-timing": "cfRequestDuration;dur=2" }
            });
        record.asked.push(size);
        open += 1;
        record.widest = Math.max(record.widest, open);
        let sent = 0;
        let body: ReadableStreamDefaultController<Uint8Array> | null = null;
        init.signal?.addEventListener("abort", () => body?.error(new Error("aborted")));
        return new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    body = controller;
                },
                pull(controller) {
                    if (options.stall) return new Promise(() => undefined);
                    // Let the other connections open before this one finishes,
                    // the way they overlap on a real link.
                    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
                        if (sent >= 3 * size) {
                            open -= 1;
                            return controller.close();
                        }
                        const piece = Math.min(PIECE, size);
                        sent += piece;
                        record.pulled += piece;
                        controller.enqueue(new Uint8Array(piece));
                    });
                },
                cancel() {
                    open -= 1;
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
    it("moves no more than each leg's cap, and bounds every request", async () => {
        const record = seen();
        vi.stubGlobal("fetch", endpoint(record));
        const outcome = await runSpeedTest();
        expect(outcome.ok).toBe(true);
        expect(record.asked.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(DOWNLOAD_BYTES);
        // The far end sends three times what is asked; reading stops at each
        // request's size, give or take one piece already buffered per request.
        expect(record.pulled).toBeLessThanOrEqual(DOWNLOAD_BYTES + record.asked.length * PIECE);
        expect(record.uploaded.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(UPLOAD_BYTES);
        expect(record.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
        expect(setSetting).toHaveBeenCalledWith("diagnostics.speedTest", expect.any(String));
        if (outcome.ok) {
            expect(outcome.result.downloadMbps).toBeGreaterThan(0);
            expect(outcome.result.uploadMbps).toBeGreaterThan(0);
            expect(outcome.result.latencyMs).not.toBeNull();
        }
    });

    it("fills the line with several connections, each asking for more as it goes", async () => {
        const record = seen();
        vi.stubGlobal("fetch", endpoint(record));
        await runSpeedTest();
        // One connection measured a third of a gigabit line; several at once is the fix.
        expect(record.widest).toBe(STREAMS);
        // Every connection starts small, so a slow line still finishes something.
        expect(record.asked.slice(0, STREAMS)).toEqual(Array(STREAMS).fill(DOWNLOAD_CHUNKS[0]));
        expect(record.uploaded.slice(0, STREAMS)).toEqual(Array(STREAMS).fill(UPLOAD_CHUNKS[0]));
        expect(Math.max(...record.asked)).toBe(DOWNLOAD_CHUNKS[DOWNLOAD_CHUNKS.length - 1]);
        expect(Math.max(...record.uploaded)).toBe(UPLOAD_CHUNKS[UPLOAD_CHUNKS.length - 1]);
    });

    it("steps a connection down when the far end refuses its size, instead of ending it", async () => {
        // The endpoint's own limit on large requests, seen from an address that
        // has used it a lot: 10 MB refused, 5 MB served.
        const record = seen();
        vi.stubGlobal("fetch", endpoint(record, { refuseAbove: 5_000_000 }));
        const outcome = await runSpeedTest();
        expect(Math.max(...record.uploaded)).toBe(5_000_000);
        // Every connection kept going at the size that works, to the leg's cap.
        expect(record.uploaded.reduce((sum, size) => sum + size, 0)).toBe(UPLOAD_BYTES);
        expect(outcome.ok && outcome.result.uploadMbps).toBeGreaterThan(0);
    });

    it("says which data center answered", async () => {
        vi.stubGlobal("fetch", endpoint(seen()));
        const outcome = await runSpeedTest();
        expect(outcome.ok && outcome.result.server).toBe("MAD");
    });

    it("reads a result stored before the data center was recorded", () => {
        const stored = { downloadMbps: 393, uploadMbps: 78.2, latencyMs: 58, at: "2026-10-19T10:00:00.000Z" };
        expect(speedResultSchema.safeParse(stored).success).toBe(true);
    });

    it("measures nothing for a download that stalls, and still measures the upload", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const record = seen();
        vi.stubGlobal("fetch", endpoint(record, { stall: true }));
        const pending = runSpeedTest();
        await vi.advanceTimersByTimeAsync(LEG_TIMEOUT_MS + 10);
        const outcome = await pending;
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            expect(outcome.result.downloadMbps).toBeNull();
            expect(outcome.result.uploadMbps).toBeGreaterThan(0);
        }
    });

    /**
     * A line where every upload takes the time its size needs at `perStreamMbps`
     * per connection; downloads stall, so only the upload is measured.
     */
    function timedUploads(perStreamMbps: number) {
        return vi.fn(async (url: string, init: RequestInit = {}) => {
            if (url.includes("bytes=0")) return new Response(null);
            if (!url.includes("__up")) {
                // A download that never sends, and ends on abort as a real one does.
                let body: ReadableStreamDefaultController<Uint8Array> | null = null;
                init.signal?.addEventListener("abort", () => body?.error(new Error("aborted")));
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            body = controller;
                        },
                        pull: () => new Promise(() => undefined)
                    })
                );
            }
            const size = (init.body as Uint8Array).byteLength;
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, (size * 8) / (perStreamMbps * 1000));
                init.signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(new Error("aborted"));
                });
            });
            return new Response("ok");
        });
    }

    async function uploadOn(perStreamMbps: number): Promise<number | null | undefined> {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        vi.stubGlobal("fetch", timedUploads(perStreamMbps));
        const pending = runSpeedTest();
        await vi.advanceTimersByTimeAsync(4 * LEG_TIMEOUT_MS);
        const outcome = await pending;
        return outcome.ok ? outcome.result.uploadMbps : undefined;
    }

    it("adds up the connections without crediting chunks that finished together", async () => {
        // Four connections at 250 Mbps each: a gigabit line, not more.
        expect(await uploadOn(250)).toBeCloseTo(STREAMS * 250, 0);
    });

    it("still measures a slow line that finishes only its first chunk", async () => {
        // 1.25 Mbps per connection: the first 1 MB takes 6.4 s, the next never
        // finishes before the deadline. Five megabits, not nothing.
        expect(await uploadOn(1.25)).toBeCloseTo(STREAMS * 1.25, 1);
    });

    it("runs one test at a time, even for two requests landing together", async () => {
        vi.stubGlobal("fetch", endpoint(seen()));
        const [first, second] = await Promise.all([runSpeedTest(), runSpeedTest()]);
        expect(first.ok).toBe(true);
        expect(second).toMatchObject({ ok: false, reason: "busy" });
        expect(rateLimit).toHaveBeenCalledTimes(1);
    });

    it("is rate limited for the whole deployment, and spends nothing when refused", async () => {
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        rateLimit.mockResolvedValueOnce({ ok: false, retryAfterMs: 120_000 });
        expect(await runSpeedTest()).toEqual({
            ok: false,
            reason: "limited",
            retryAfterMs: 120_000
        });
        expect(rateLimit).toHaveBeenCalledWith(
            "diagnostics:speed-test",
            SPEED_TEST_LIMIT,
            SPEED_TEST_WINDOW_MS
        );
        expect(fetcher).not.toHaveBeenCalled();
        // The refusal released the lock: the next one is asked again.
        vi.stubGlobal("fetch", endpoint(seen()));
        expect((await runSpeedTest()).ok).toBe(true);
    });

    it("keeps its limits within what the screen says it uses", () => {
        // The card says "up to 300 MB".
        expect(DOWNLOAD_BYTES + UPLOAD_BYTES).toBeLessThanOrEqual(300_000_000);
        expect(LEG_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
        expect(SPEED_TEST_LIMIT).toBeLessThanOrEqual(5);
    });

    it("converts to megabits per second, and nothing measured is null", () => {
        expect(mbps(1_250_000, 1000)).toBe(10);
        expect(mbps(0, 1000)).toBeNull();
        expect(mbps(1000, 0)).toBeNull();
    });
});
