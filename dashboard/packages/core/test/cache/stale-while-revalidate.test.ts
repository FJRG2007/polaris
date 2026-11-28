/**
 * The shared read cache behind screens that ask somebody else's service:
 * a held answer is served at once, concurrent callers share one refresh, a
 * slow first answer gives up waiting without cancelling it, and a failure
 * keeps what was known.
 */

import { describe, expect, it } from "vitest";
import { staleWhileRevalidate } from "../../src/stale-while-revalidate";

/** A load whose answer the test settles by hand, counting how often it ran. */
function controlled<V>() {
    const calls: Array<{ resolve: (value: V) => void; reject: (error: unknown) => void }> = [];
    const load = () =>
        new Promise<V>((resolve, reject) => {
            calls.push({ resolve, reject });
        });
    return { calls, load };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("staleWhileRevalidate", () => {
    it("serves a stale answer at once and refreshes it once in the background", async () => {
        let clock = 0;
        const cache = staleWhileRevalidate<string>({ freshMs: 1000, now: () => clock });
        cache.set("repo", "v1");
        clock = 5000;
        const { calls, load } = controlled<string>();

        const reads = await Promise.all(Array.from({ length: 1000 }, () => cache.read("repo", load)));

        expect(reads.every((read) => read.value === "v1" && read.stale)).toBe(true);
        expect(calls).toHaveLength(1);
        calls[0]!.resolve("v2");
        await tick();
        expect((await cache.read("repo", load)).value).toBe("v2");
        expect(calls).toHaveLength(1);
    });

    it("does not refresh a fresh answer", async () => {
        let clock = 0;
        const cache = staleWhileRevalidate<string>({ freshMs: 1000, now: () => clock });
        cache.set("repo", "v1");
        clock = 999;
        const { calls, load } = controlled<string>();
        expect((await cache.read("repo", load)).stale).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it("shares one first load between concurrent callers with nothing held", async () => {
        const cache = staleWhileRevalidate<string>({ freshMs: 1000 });
        const { calls, load } = controlled<string>();
        const reads = Array.from({ length: 50 }, () => cache.get("repo", load));
        await tick();
        expect(calls).toHaveLength(1);
        calls[0]!.resolve("v1");
        expect(await Promise.all(reads)).toEqual(Array(50).fill("v1"));
    });

    it("stops waiting on a slow first load, which still fills the key", async () => {
        const cache = staleWhileRevalidate<string>({ freshMs: 1000, waitMs: 20 });
        const { calls, load } = controlled<string>();
        const started = Date.now();
        const read = await cache.read("repo", load);
        expect(read.value).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1000);
        calls[0]!.resolve("late");
        await tick();
        expect(cache.peek("repo").value).toBe("late");
    });

    it("keeps the stale answer when a refresh times out or fails, and retries later", async () => {
        let clock = 0;
        const cache = staleWhileRevalidate<string>({ freshMs: 1000, retryMs: 100, now: () => clock });
        cache.set("repo", "v1");
        clock = 2000;
        const { calls, load } = controlled<string>();

        expect((await cache.read("repo", load)).value).toBe("v1");
        calls[0]!.reject(new Error("rate limited"));
        await tick();

        clock = 2050;
        expect((await cache.read("repo", load)).value).toBe("v1");
        expect(calls).toHaveLength(1);

        clock = 2200;
        expect((await cache.read("repo", load)).value).toBe("v1");
        expect(calls).toHaveLength(2);
    });

    it("answers undefined after a failed first load without asking again until the retry", async () => {
        let clock = 0;
        const cache = staleWhileRevalidate<string>({ freshMs: 1000, retryMs: 100, now: () => clock });
        let calls = 0;
        const failing = async () => {
            calls += 1;
            throw new Error("down");
        };
        expect((await cache.read("repo", failing)).value).toBeUndefined();
        expect((await cache.read("repo", failing)).value).toBeUndefined();
        expect(calls).toBe(1);
        clock = 200;
        await cache.read("repo", failing);
        expect(calls).toBe(2);
    });

    it("passes the held answer to the load, and honours a per-answer freshness", async () => {
        let clock = 0;
        const cache = staleWhileRevalidate<{ v: number; partial: boolean }>({
            freshMs: 1000,
            freshFor: (value) => (value.partial ? 10 : 1000),
            now: () => clock
        });
        const seen: unknown[] = [];
        const load = async (previous: { v: number; partial: boolean } | undefined) => {
            seen.push(previous);
            return { v: (previous?.v ?? 0) + 1, partial: true };
        };
        await cache.get("k", load);
        clock = 20;
        await cache.get("k", load);
        await tick();
        expect(seen).toEqual([undefined, { v: 1, partial: true }]);
        expect(cache.peek("k").value?.v).toBe(2);
    });

    it("refresh waits for a fresh answer and joins one already running", async () => {
        let clock = 0;
        const cache = staleWhileRevalidate<string>({ freshMs: 1000, now: () => clock });
        cache.set("repo", "v1");
        clock = 5000;
        const { calls, load } = controlled<string>();
        await cache.read("repo", load);
        const forced = cache.refresh("repo", load);
        expect(calls).toHaveLength(1);
        calls[0]!.resolve("v2");
        expect(await forced).toBe("v2");
    });

    it("holds at most maxKeys, dropping the oldest settled first", () => {
        const cache = staleWhileRevalidate<number>({ freshMs: 1000, maxKeys: 2 });
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        expect(cache.size).toBe(2);
        expect(cache.peek("a").value).toBeUndefined();
        expect(cache.peek("c").value).toBe(3);
    });
});
